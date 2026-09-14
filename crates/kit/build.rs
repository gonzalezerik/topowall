//! Embed the vendored base16 schemes as a (name, contents) table.

use std::{env, fs, path::Path};

fn main() {
    let dir = "palettes/base16";
    let mut entries: Vec<_> = fs::read_dir(dir)
        .unwrap_or_else(|e| panic!("reading {dir}: {e}"))
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|x| x == "yaml"))
        .collect();
    entries.sort();

    let mut src = String::from("&[\n");
    for p in &entries {
        let name = p.file_stem().unwrap().to_string_lossy();
        let abs = fs::canonicalize(p).unwrap();
        src.push_str(&format!(
            "    ({name:?}, include_str!({:?})),\n",
            abs.display().to_string()
        ));
    }
    src.push(']');
    fs::write(
        Path::new(&env::var("OUT_DIR").unwrap()).join("base16.rs"),
        src,
    )
    .unwrap();
    println!("cargo:rerun-if-changed={dir}");
}
