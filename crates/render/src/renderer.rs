//! Headless wgpu renderer: heightmap + theme → RGBA image.

use crate::theme::ResolvedTheme;
use anyhow::{bail, Context, Result};
use bytemuck::{Pod, Zeroable};
use topowall_core::Heightmap;
use wgpu::util::DeviceExt;

use crate::gpu::{self, GpuInfo, GpuOptions};

pub const SHADER_SOURCE: &str = include_str!("shaders/contour.wgsl");
const TILE: u32 = 4096;

/// Most line tiers and color stops a theme can use (fixed-size uniform arrays).
pub const MAX_TIERS: usize = 8;
pub const MAX_STOPS: usize = 32;

#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
struct GpuTier {
    a: [f32; 4],
    b: [f32; 4],
}

#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
struct GpuStop {
    color: [f32; 4],
    elev: [f32; 4],
}

/// Matches `struct Params` in contour.wgsl (std140: all members are vec4-aligned).
#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
struct Params {
    size_origin: [f32; 4],
    map: [f32; 4],
    background: [f32; 4],
    elev_range: [f32; 4],
    tiers: [GpuTier; MAX_TIERS],
    stops: [GpuStop; MAX_STOPS],
}

/// How the heightmap is placed in the output.
#[derive(Debug, Clone, Copy)]
pub enum Framing {
    /// Scale to cover the output, centred (crops if aspect ratios differ).
    Cover,
    /// Fixed ground scale in metres per output pixel, centred.
    MetresPerPixel(f64),
}

impl Framing {
    /// Heightmap cells per output pixel for an output of `width` x `height`.
    pub fn tex_per_px(self, hm: &Heightmap, width: u32, height: u32) -> Result<f64> {
        Ok(match self {
            Framing::Cover => {
                (hm.width as f64 / width as f64).min(hm.height as f64 / height as f64)
            }
            Framing::MetresPerPixel(m) => {
                let cell = hm
                    .m_per_px
                    .context("--scale needs a heightmap with known metres per pixel")?;
                m / cell
            }
        })
    }
}

pub struct Renderer {
    device: wgpu::Device,
    queue: wgpu::Queue,
    info: GpuInfo,
}

/// Put a custom `fn shade` into the shader template.
pub fn shader_with_shade(custom: Option<&str>) -> Result<String> {
    let Some(custom) = custom else {
        return Ok(SHADER_SOURCE.to_string());
    };
    let (Some(b), Some(e)) = (
        SHADER_SOURCE.find("//@shade-begin"),
        SHADER_SOURCE.find("//@shade-end"),
    ) else {
        bail!("shader template is missing shade markers");
    };
    if !custom.contains("fn shade") {
        bail!("custom shader must define `fn shade(s: ShadeInput) -> vec4<f32>`");
    }
    Ok(format!(
        "{}{}\n{}",
        &SHADER_SOURCE[..b],
        custom,
        &SHADER_SOURCE[e..]
    ))
}

impl Renderer {
    /// Open the best available GPU.
    pub fn new() -> Result<Self> {
        Self::with_options(&GpuOptions::default())
    }

    pub fn with_options(opts: &GpuOptions) -> Result<Self> {
        let gpu::Gpu {
            device,
            queue,
            info,
        } = gpu::select(opts)?;
        Ok(Self {
            device,
            queue,
            info,
        })
    }

    pub fn gpu(&self) -> &GpuInfo {
        &self.info
    }

    pub fn adapter_name(&self) -> String {
        self.info.to_string()
    }

    /// Largest heightmap or tile edge this GPU accepts.
    pub fn max_texture_size(&self) -> u32 {
        self.device.limits().max_texture_dimension_2d
    }

    /// If `hm` is larger than this GPU's texture limit, a resized copy that fits.
    pub fn fit_heightmap(&self, hm: &Heightmap) -> Option<Heightmap> {
        let max = self.max_texture_size() as usize;
        if hm.width <= max && hm.height <= max {
            return None;
        }
        let s = max as f64 / hm.width.max(hm.height) as f64;
        let (w, h) = (
            ((hm.width as f64 * s).floor() as usize).clamp(1, max),
            ((hm.height as f64 * s).floor() as usize).clamp(1, max),
        );
        Some(topowall_core::resample::resize(hm, w, h))
    }

    /// Render `hm` with `theme` into an RGBA8 buffer of `width` x `height`.
    pub fn render(
        &self,
        hm: &Heightmap,
        theme: &ResolvedTheme,
        width: u32,
        height: u32,
        framing: Framing,
    ) -> Result<Vec<u8>> {
        let max_tex = self.device.limits().max_texture_dimension_2d;
        if hm.width as u32 > max_tex || hm.height as u32 > max_tex {
            bail!(
                "heightmap {}x{} exceeds this GPU's texture limit ({max_tex}); resize it with Renderer::fit_heightmap",
                hm.width,
                hm.height
            );
        }
        if theme.tiers.len() > MAX_TIERS {
            bail!(
                "themes can have at most {MAX_TIERS} line tiers (this one has {})",
                theme.tiers.len()
            );
        }
        let stop_count: usize = theme.tiers.iter().map(|t| t.stops.len()).sum();
        if stop_count > MAX_STOPS {
            bail!("themes can have at most {MAX_STOPS} color stops in total (this one has {stop_count})");
        }
        if width == 0 || height == 0 {
            bail!("output size must be positive");
        }

        let tex_per_px = framing.tex_per_px(hm, width, height)? as f32;
        let (lo, hi) = hm.min_max();

        // ── GPU resources ──
        let dem = self.device.create_texture_with_data(
            &self.queue,
            &wgpu::TextureDescriptor {
                label: Some("dem"),
                size: wgpu::Extent3d {
                    width: hm.width as u32,
                    height: hm.height as u32,
                    depth_or_array_layers: 1,
                },
                mip_level_count: 1,
                sample_count: 1,
                dimension: wgpu::TextureDimension::D2,
                format: wgpu::TextureFormat::R32Float,
                usage: wgpu::TextureUsages::TEXTURE_BINDING,
                view_formats: &[],
            },
            wgpu::util::TextureDataOrder::LayerMajor,
            bytemuck::cast_slice(&hm.data),
        );

        let mut tiers = [GpuTier::zeroed(); MAX_TIERS];
        let mut stops = [GpuStop::zeroed(); MAX_STOPS];
        let mut next_stop = 0;
        for (i, t) in theme.tiers.iter().enumerate() {
            tiers[i] = GpuTier {
                a: [t.every, t.offset, t.width, t.opacity],
                b: [next_stop as f32, t.stops.len() as f32, 0.0, 0.0],
            };
            for (e, c) in &t.stops {
                stops[next_stop] = GpuStop {
                    color: c.to_array(),
                    elev: [*e, 0.0, 0.0, 0.0],
                };
                next_stop += 1;
            }
        }
        let mut params = Params {
            size_origin: [width as f32, height as f32, 0.0, 0.0],
            map: [
                hm.width as f32 * 0.5,
                hm.height as f32 * 0.5,
                tex_per_px,
                theme.tiers.len() as f32,
            ],
            background: theme.background.to_array(),
            elev_range: [lo, hi, 0.0, 0.0],
            tiers,
            stops,
        };
        let params_buf = self
            .device
            .create_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: Some("params"),
                contents: bytemuck::bytes_of(&params),
                usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            });

        let source = shader_with_shade(theme.shader.as_deref())?;
        self.device.push_error_scope(wgpu::ErrorFilter::Validation);
        let module = self
            .device
            .create_shader_module(wgpu::ShaderModuleDescriptor {
                label: Some("contour"),
                source: wgpu::ShaderSource::Wgsl(source.into()),
            });
        if let Some(err) = pollster::block_on(self.device.pop_error_scope()) {
            bail!("shader error: {err}");
        }

        let format = wgpu::TextureFormat::Rgba8Unorm;
        let pipeline = self
            .device
            .create_render_pipeline(&wgpu::RenderPipelineDescriptor {
                label: Some("contour"),
                layout: None,
                vertex: wgpu::VertexState {
                    module: &module,
                    entry_point: Some("vs"),
                    compilation_options: Default::default(),
                    buffers: &[],
                },
                fragment: Some(wgpu::FragmentState {
                    module: &module,
                    entry_point: Some("fs"),
                    compilation_options: Default::default(),
                    targets: &[Some(wgpu::ColorTargetState {
                        format,
                        blend: None,
                        write_mask: wgpu::ColorWrites::ALL,
                    })],
                }),
                primitive: wgpu::PrimitiveState::default(),
                depth_stencil: None,
                multisample: wgpu::MultisampleState::default(),
                multiview: None,
                cache: None,
            });
        let bind_group = self.device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("contour"),
            layout: &pipeline.get_bind_group_layout(0),
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: params_buf.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: wgpu::BindingResource::TextureView(
                        &dem.create_view(&Default::default()),
                    ),
                },
            ],
        });

        // ── Render in tiles so outputs can exceed the texture limit ──
        let tile = TILE.min(max_tex);
        let target = self.device.create_texture(&wgpu::TextureDescriptor {
            label: Some("target"),
            size: wgpu::Extent3d {
                width: tile.min(width),
                height: tile.min(height),
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format,
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_SRC,
            view_formats: &[],
        });
        let target_view = target.create_view(&Default::default());
        let (tw, th) = (target.width(), target.height());
        let align = wgpu::COPY_BYTES_PER_ROW_ALIGNMENT;
        let padded_row = (4 * tw).div_ceil(align) * align;
        let readback = self.device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("readback"),
            size: (padded_row * th) as u64,
            usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });

        let mut out = vec![0u8; (width as usize) * (height as usize) * 4];
        for ty in (0..height).step_by(th as usize) {
            for tx in (0..width).step_by(tw as usize) {
                params.size_origin[2] = tx as f32;
                params.size_origin[3] = ty as f32;
                self.queue
                    .write_buffer(&params_buf, 0, bytemuck::bytes_of(&params));

                let mut enc = self.device.create_command_encoder(&Default::default());
                {
                    let mut pass = enc.begin_render_pass(&wgpu::RenderPassDescriptor {
                        label: Some("contour"),
                        color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                            view: &target_view,
                            resolve_target: None,
                            ops: wgpu::Operations {
                                load: wgpu::LoadOp::Clear(wgpu::Color::BLACK),
                                store: wgpu::StoreOp::Store,
                            },
                        })],
                        depth_stencil_attachment: None,
                        timestamp_writes: None,
                        occlusion_query_set: None,
                    });
                    pass.set_pipeline(&pipeline);
                    pass.set_bind_group(0, &bind_group, &[]);
                    pass.draw(0..3, 0..1);
                }
                enc.copy_texture_to_buffer(
                    target.as_image_copy(),
                    wgpu::TexelCopyBufferInfo {
                        buffer: &readback,
                        layout: wgpu::TexelCopyBufferLayout {
                            offset: 0,
                            bytes_per_row: Some(padded_row),
                            rows_per_image: None,
                        },
                    },
                    wgpu::Extent3d {
                        width: tw,
                        height: th,
                        depth_or_array_layers: 1,
                    },
                );
                self.queue.submit([enc.finish()]);

                let slice = readback.slice(..);
                let (tx_ch, rx_ch) = std::sync::mpsc::channel();
                slice.map_async(wgpu::MapMode::Read, move |r| {
                    let _ = tx_ch.send(r);
                });
                self.device.poll(wgpu::PollType::Wait)?;
                rx_ch.recv()?.context("mapping readback buffer")?;
                {
                    let data = slice.get_mapped_range();
                    let cw = tw.min(width - tx) as usize;
                    let ch = th.min(height - ty) as usize;
                    for row in 0..ch {
                        let src = row * padded_row as usize;
                        let dst = ((ty as usize + row) * width as usize + tx as usize) * 4;
                        out[dst..dst + cw * 4].copy_from_slice(&data[src..src + cw * 4]);
                    }
                }
                readback.unmap();
            }
        }
        Ok(out)
    }
}
