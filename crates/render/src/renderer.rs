//! Headless wgpu renderer: heightmap + theme → RGBA image.

use crate::theme::ResolvedTheme;
use anyhow::{bail, Context, Result};
use bytemuck::{Pod, Zeroable};
use topowall_core::Heightmap;
use wgpu::util::DeviceExt;

pub const SHADER_SOURCE: &str = include_str!("shaders/contour.wgsl");
const TILE: u32 = 4096;

#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
struct Params {
    size_origin: [f32; 4],
    map: [f32; 4],
    background: [f32; 4],
    elev_range: [f32; 4],
}

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
    adapter_info: wgpu::AdapterInfo,
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
    pub fn new() -> Result<Self> {
        pollster::block_on(async {
            let instance = wgpu::Instance::new(&wgpu::InstanceDescriptor {
                backends: wgpu::Backends::PRIMARY | wgpu::Backends::GL,
                ..Default::default()
            });
            let adapter = instance
                .request_adapter(&wgpu::RequestAdapterOptions {
                    power_preference: wgpu::PowerPreference::HighPerformance,
                    compatible_surface: None,
                    force_fallback_adapter: false,
                })
                .await
                .context(
                    "no GPU adapter found (is a Vulkan, Metal, DX12 or OpenGL driver installed?)",
                )?;
            let limits = adapter.limits();
            let (device, queue) = adapter
                .request_device(&wgpu::DeviceDescriptor {
                    label: Some("topowall"),
                    required_features: wgpu::Features::empty(),
                    required_limits: wgpu::Limits {
                        max_texture_dimension_2d: limits.max_texture_dimension_2d,
                        max_storage_buffer_binding_size: limits.max_storage_buffer_binding_size,
                        ..wgpu::Limits::downlevel_defaults()
                    },
                    memory_hints: wgpu::MemoryHints::Performance,
                    trace: wgpu::Trace::Off,
                })
                .await
                .context("requesting GPU device")?;
            let adapter_info = adapter.get_info();
            Ok(Self {
                device,
                queue,
                adapter_info,
            })
        })
    }

    pub fn adapter_name(&self) -> String {
        format!(
            "{} ({:?})",
            self.adapter_info.name, self.adapter_info.backend
        )
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
                "heightmap {}x{} exceeds this GPU's texture limit ({max_tex})",
                hm.width,
                hm.height
            );
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

        let mut gpu_tiers = Vec::new();
        let mut gpu_stops = Vec::new();
        for t in &theme.tiers {
            gpu_tiers.push(GpuTier {
                a: [t.every, t.offset, t.width, t.opacity],
                b: [gpu_stops.len() as f32, t.stops.len() as f32, 0.0, 0.0],
            });
            gpu_stops.extend(t.stops.iter().map(|(e, c)| GpuStop {
                color: c.to_array(),
                elev: [*e, 0.0, 0.0, 0.0],
            }));
        }
        if gpu_tiers.is_empty() {
            // Storage buffers can't be empty; a zero-opacity tier draws nothing.
            gpu_tiers.push(GpuTier {
                a: [1.0, 0.0, 0.0, 0.0],
                b: [0.0, 1.0, 0.0, 0.0],
            });
        }
        if gpu_stops.is_empty() {
            gpu_stops.push(GpuStop {
                color: [0.0; 4],
                elev: [0.0; 4],
            });
        }
        let storage = |label, contents: &[u8]| {
            self.device
                .create_buffer_init(&wgpu::util::BufferInitDescriptor {
                    label: Some(label),
                    contents,
                    usage: wgpu::BufferUsages::STORAGE,
                })
        };
        let tiers_buf = storage("tiers", bytemuck::cast_slice(&gpu_tiers));
        let stops_buf = storage("stops", bytemuck::cast_slice(&gpu_stops));
        let params_buf = self.device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("params"),
            size: std::mem::size_of::<Params>() as u64,
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
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
                wgpu::BindGroupEntry {
                    binding: 2,
                    resource: tiers_buf.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 3,
                    resource: stops_buf.as_entire_binding(),
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
                let params = Params {
                    size_origin: [width as f32, height as f32, tx as f32, ty as f32],
                    map: [
                        hm.width as f32 * 0.5,
                        hm.height as f32 * 0.5,
                        tex_per_px,
                        0.0,
                    ],
                    background: theme.background.to_array(),
                    elev_range: [lo, hi, 0.0, 0.0],
                };
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
