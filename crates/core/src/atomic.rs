//! Replacing files safely.
//!
//! Output is written to a temporary file next to the destination and renamed
//! over it only once writing has fully succeeded, so a failed write (encoder
//! error, full disk, interrupted process) never leaves a truncated or partial
//! file where the old one was.

use anyhow::{Context, Result};
use std::{
    fs::{self, File},
    io::{BufWriter, Write},
    path::{Path, PathBuf},
};

fn temp_path(path: &Path) -> Result<PathBuf> {
    let name = path
        .file_name()
        .with_context(|| format!("'{}' is not a file path", path.display()))?;
    let dir = path
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    Ok(dir.join(format!(
        ".{}.{}.tmp",
        name.to_string_lossy(),
        std::process::id()
    )))
}

/// Write `path` through `write`, replacing any existing file only on success.
pub fn write_file<F>(path: &Path, write: F) -> Result<()>
where
    F: FnOnce(&mut BufWriter<File>) -> Result<()>,
{
    let tmp = temp_path(path)?;
    let result = (|| -> Result<()> {
        let file = File::create(&tmp)
            .with_context(|| format!("creating temporary file {}", tmp.display()))?;
        let mut writer = BufWriter::new(file);
        write(&mut writer)?;
        writer.flush()?;
        let file = writer.into_inner().map_err(|e| e.into_error())?;
        file.sync_all()?;
        drop(file);
        // Keep the permissions of the file being replaced.
        if let Ok(meta) = fs::metadata(path) {
            fs::set_permissions(&tmp, meta.permissions())?;
        }
        fs::rename(&tmp, path)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result.with_context(|| format!("writing {}", path.display()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use anyhow::bail;
    use std::io::Write;

    fn scratch(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("topowall-atomic-{}-{name}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn leftovers(dir: &Path) -> Vec<String> {
        fs::read_dir(dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .filter(|n| n.ends_with(".tmp"))
            .collect()
    }

    #[test]
    fn failed_write_keeps_the_existing_file() {
        let dir = scratch("fail");
        let path = dir.join("wallpaper.jpg");
        fs::write(&path, b"old wallpaper").unwrap();

        let err = write_file(&path, |w| {
            w.write_all(b"half an ima")?;
            bail!("encoder failed")
        });

        assert!(err.is_err());
        assert_eq!(fs::read(&path).unwrap(), b"old wallpaper");
        assert!(leftovers(&dir).is_empty(), "temporary file left behind");
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn successful_write_replaces_the_file() {
        let dir = scratch("ok");
        let path = dir.join("wallpaper.png");
        fs::write(&path, b"old").unwrap();

        write_file(&path, |w| Ok(w.write_all(b"new image")?)).unwrap();

        assert_eq!(fs::read(&path).unwrap(), b"new image");
        assert!(leftovers(&dir).is_empty());
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn creates_new_files_and_relative_paths() {
        let dir = scratch("new");
        let path = dir.join("fresh.topo");
        write_file(&path, |w| Ok(w.write_all(b"data")?)).unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"data");
        assert_eq!(
            temp_path(Path::new("out.png")).unwrap().parent(),
            Some(Path::new("."))
        );
        fs::remove_dir_all(dir).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn keeps_permissions_of_the_replaced_file() {
        use std::os::unix::fs::PermissionsExt;
        let dir = scratch("perm");
        let path = dir.join("shared.png");
        fs::write(&path, b"old").unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o640)).unwrap();

        write_file(&path, |w| Ok(w.write_all(b"new")?)).unwrap();

        assert_eq!(
            fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o640
        );
        fs::remove_dir_all(dir).unwrap();
    }
}
