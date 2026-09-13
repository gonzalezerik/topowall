//! Finding a GPU to render on.
//!
//! Every adapter wgpu can see is considered — dedicated or integrated
//! (Intel, AMD, NVIDIA, Apple, ARM), on Vulkan, Metal, DX12 or OpenGL — and
//! tried in order until one gives a working device. Without any GPU driver,
//! a software renderer is used as a last resort (WARP on Windows,
//! lavapipe/llvmpipe on Linux when Mesa is installed).

use anyhow::{bail, Context, Result};
use std::fmt;

/// Which graphics API to use.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Backend {
    /// Try everything available, best first.
    #[default]
    Auto,
    Vulkan,
    Metal,
    Dx12,
    Gl,
}

impl Backend {
    pub fn parse(s: &str) -> Result<Self> {
        Ok(match s.trim().to_ascii_lowercase().as_str() {
            "" | "auto" => Backend::Auto,
            "vulkan" | "vk" => Backend::Vulkan,
            "metal" | "mtl" => Backend::Metal,
            "dx12" | "d3d12" | "directx" => Backend::Dx12,
            "gl" | "opengl" | "gles" => Backend::Gl,
            other => bail!("unknown backend '{other}' (use auto, vulkan, metal, dx12 or gl)"),
        })
    }

    fn wgpu(self) -> wgpu::Backends {
        match self {
            Backend::Auto => wgpu::Backends::all(),
            Backend::Vulkan => wgpu::Backends::VULKAN,
            Backend::Metal => wgpu::Backends::METAL,
            Backend::Dx12 => wgpu::Backends::DX12,
            Backend::Gl => wgpu::Backends::GL,
        }
    }
}

/// Which adapter to use and how.
#[derive(Debug, Clone, Default)]
pub struct GpuOptions {
    pub backend: Backend,
    /// An index from [`list_gpus`] or part of an adapter's name (case-insensitive),
    /// e.g. "intel", "radeon", "nvidia".
    pub gpu: Option<String>,
}

/// A GPU (or software renderer) that topowall can use.
#[derive(Debug, Clone)]
pub struct GpuInfo {
    pub index: usize,
    pub name: String,
    pub kind: GpuKind,
    pub backend: String,
    pub driver: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GpuKind {
    Discrete,
    Integrated,
    Virtual,
    Software,
    Other,
}

impl fmt::Display for GpuKind {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            GpuKind::Discrete => "dedicated GPU",
            GpuKind::Integrated => "integrated GPU",
            GpuKind::Virtual => "virtual GPU",
            GpuKind::Software => "software (CPU)",
            GpuKind::Other => "GPU",
        })
    }
}

impl From<wgpu::DeviceType> for GpuKind {
    fn from(t: wgpu::DeviceType) -> Self {
        match t {
            wgpu::DeviceType::DiscreteGpu => GpuKind::Discrete,
            wgpu::DeviceType::IntegratedGpu => GpuKind::Integrated,
            wgpu::DeviceType::VirtualGpu => GpuKind::Virtual,
            wgpu::DeviceType::Cpu => GpuKind::Software,
            wgpu::DeviceType::Other => GpuKind::Other,
        }
    }
}

impl fmt::Display for GpuInfo {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{} ({}, {})", self.name, self.kind, self.backend)
    }
}

/// Lower is better: dedicated, then integrated, then virtual; software last.
fn kind_rank(kind: GpuKind) -> u8 {
    match kind {
        GpuKind::Discrete => 0,
        GpuKind::Integrated => 1,
        GpuKind::Virtual => 2,
        GpuKind::Other => 3,
        GpuKind::Software => 4,
    }
}

/// Lower is better: each platform's native API first, OpenGL last.
fn backend_rank(backend: wgpu::Backend) -> u8 {
    use wgpu::Backend as B;
    let order: &[B] = if cfg!(target_os = "windows") {
        &[B::Dx12, B::Vulkan, B::Gl]
    } else if cfg!(target_vendor = "apple") {
        &[B::Metal, B::Vulkan, B::Gl]
    } else {
        &[B::Vulkan, B::Gl]
    };
    order
        .iter()
        .position(|b| *b == backend)
        .unwrap_or(order.len()) as u8
}

fn info_of(index: usize, a: &wgpu::AdapterInfo) -> GpuInfo {
    let driver = [a.driver.as_str(), a.driver_info.as_str()]
        .iter()
        .filter(|s| !s.is_empty())
        .copied()
        .collect::<Vec<_>>()
        .join(" ");
    GpuInfo {
        index,
        name: a.name.clone(),
        kind: a.device_type.into(),
        backend: format!("{:?}", a.backend),
        driver,
    }
}

fn instance(backend: Backend) -> wgpu::Instance {
    wgpu::Instance::new(&wgpu::InstanceDescriptor {
        backends: backend.wgpu(),
        ..Default::default()
    })
}

/// All adapters, best first. Indices match what `--gpu N` selects.
fn sorted_adapters(instance: &wgpu::Instance, backend: Backend) -> Vec<wgpu::Adapter> {
    let mut adapters = instance.enumerate_adapters(backend.wgpu());
    adapters.sort_by_key(|a| {
        let i = a.get_info();
        (kind_rank(i.device_type.into()), backend_rank(i.backend))
    });
    adapters
}

/// List every adapter topowall can see, best first.
pub fn list_gpus(backend: Backend) -> Vec<GpuInfo> {
    let instance = instance(backend);
    sorted_adapters(&instance, backend)
        .iter()
        .enumerate()
        .map(|(i, a)| info_of(i, &a.get_info()))
        .collect()
}

/// A working device on the chosen adapter.
pub struct Gpu {
    pub device: wgpu::Device,
    pub queue: wgpu::Queue,
    pub info: GpuInfo,
}

async fn open(adapter: &wgpu::Adapter) -> Result<(wgpu::Device, wgpu::Queue)> {
    // Ask only for what the shader needs (WebGL2 / GLES 3.0 level), plus the
    // adapter's real texture size limit.
    let limits = wgpu::Limits::downlevel_webgl2_defaults().using_resolution(adapter.limits());
    let (device, queue) = adapter
        .request_device(&wgpu::DeviceDescriptor {
            label: Some("topowall"),
            required_features: wgpu::Features::empty(),
            required_limits: limits,
            memory_hints: wgpu::MemoryHints::Performance,
            trace: wgpu::Trace::Off,
        })
        .await?;
    Ok((device, queue))
}

/// Pick and open a GPU.
pub fn select(opts: &GpuOptions) -> Result<Gpu> {
    pollster::block_on(async {
        let instance = instance(opts.backend);
        let adapters = sorted_adapters(&instance, opts.backend);

        let candidates: Vec<(usize, &wgpu::Adapter)> = match opts.gpu.as_deref().map(str::trim) {
            None | Some("") => adapters.iter().enumerate().collect(),
            Some(sel) => {
                let picked: Vec<_> = match sel.parse::<usize>() {
                    Ok(i) => adapters
                        .iter()
                        .enumerate()
                        .filter(|(j, _)| *j == i)
                        .collect(),
                    Err(_) => {
                        let needle = sel.to_ascii_lowercase();
                        adapters
                            .iter()
                            .enumerate()
                            .filter(|(_, a)| {
                                a.get_info().name.to_ascii_lowercase().contains(&needle)
                            })
                            .collect()
                    }
                };
                if picked.is_empty() {
                    let available = adapters
                        .iter()
                        .enumerate()
                        .map(|(i, a)| format!("  {i}: {}", info_of(i, &a.get_info())))
                        .collect::<Vec<_>>()
                        .join("\n");
                    bail!("no GPU matches '{sel}'. Available:\n{available}");
                }
                picked
            }
        };

        let mut errors = Vec::new();
        for (i, adapter) in candidates {
            match open(adapter).await {
                Ok((device, queue)) => {
                    return Ok(Gpu {
                        device,
                        queue,
                        info: info_of(i, &adapter.get_info()),
                    });
                }
                Err(e) => errors.push(format!("  {}: {e:#}", info_of(i, &adapter.get_info()))),
            }
        }

        // Last resort when nothing was selected explicitly: a software adapter.
        if opts.gpu.is_none() {
            if let Ok(adapter) = instance
                .request_adapter(&wgpu::RequestAdapterOptions {
                    power_preference: wgpu::PowerPreference::None,
                    compatible_surface: None,
                    force_fallback_adapter: true,
                })
                .await
            {
                if let Ok((device, queue)) = open(&adapter).await {
                    let mut info = info_of(adapters.len(), &adapter.get_info());
                    info.kind = GpuKind::Software;
                    return Ok(Gpu {
                        device,
                        queue,
                        info,
                    });
                }
            }
        }

        let detail = if errors.is_empty() {
            "no adapters were found".to_string()
        } else {
            format!("these adapters failed:\n{}", errors.join("\n"))
        };
        Err(anyhow::anyhow!(detail)).context(
            "no usable GPU. Install or update your graphics driver: Mesa (Intel/AMD) or the NVIDIA \
             driver on Linux; on Windows the Intel, AMD or NVIDIA driver; macOS includes Metal. \
             `topowall gpus` lists what topowall can see",
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_backends() {
        assert_eq!(Backend::parse("Vulkan").unwrap(), Backend::Vulkan);
        assert_eq!(Backend::parse("opengl").unwrap(), Backend::Gl);
        assert_eq!(Backend::parse("").unwrap(), Backend::Auto);
        assert!(Backend::parse("glide").is_err());
    }

    #[test]
    fn ranks_hardware_before_software() {
        assert!(kind_rank(GpuKind::Discrete) < kind_rank(GpuKind::Integrated));
        assert!(kind_rank(GpuKind::Integrated) < kind_rank(GpuKind::Software));
        assert!(backend_rank(wgpu::Backend::Gl) > 0);
    }
}
