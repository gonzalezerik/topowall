//! Write palettes/palettes.json: every built-in scheme with its computed tags.
//!
//! cargo run -p topowall-kit --example palette-catalog [-- OUTPUT]

use topowall_kit::{palette, tags};

fn main() -> anyhow::Result<()> {
    let out = std::env::args()
        .nth(1)
        .unwrap_or_else(|| concat!(env!("CARGO_MANIFEST_DIR"), "/palettes/palettes.json").into());
    let mut text = String::from("{\n  \"palettes\": [\n");
    let names: Vec<&str> = palette::builtin_names().collect();
    for (i, name) in names.iter().enumerate() {
        let (base, title) = palette::builtin_base16(name).expect("built-in scheme parses");
        let entry = serde_json::json!({
            "name": name,
            "title": title,
            "tags": tags::compute(&base),
            "colors": base.iter().map(|c| c.to_hex()).collect::<Vec<_>>(),
        });
        text.push_str("    ");
        text.push_str(&serde_json::to_string(&entry)?);
        text.push_str(if i + 1 < names.len() { ",\n" } else { "\n" });
    }
    text.push_str("  ]\n}\n");
    topowall_kit::atomic::write_file(std::path::Path::new(&out), |f| {
        Ok(std::io::Write::write_all(f, text.as_bytes())?)
    })?;
    eprintln!("wrote {out} ({} schemes)", names.len());
    Ok(())
}
