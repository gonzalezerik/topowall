//! Embed the vendored base16 schemes and built-in themes as (name, contents) tables.

use std::{env, fs, path::Path};

fn table(dir: &str, ext: &str, out_name: &str) {
    let mut entries: Vec<_> = fs::read_dir(dir)
        .unwrap_or_else(|e| panic!("reading {dir}: {e}"))
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|x| x == ext))
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
    fs::write(Path::new(&env::var("OUT_DIR").unwrap()).join(out_name), src).unwrap();
    println!("cargo:rerun-if-changed={dir}");
}

fn main() {
    table("palettes/base16", "yaml", "base16.rs");
    table("../../themes", "toml", "themes.rs");
}
