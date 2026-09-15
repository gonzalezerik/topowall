//! "Did you mean" suggestions for mistyped names.

/// Up to `n` candidates close to `wanted`: names containing it first, then
/// names within a few typos (insertions, deletions, substitutions, swaps).
/// Dashes, spaces and underscores are ignored, so `rosepine` finds `rose-pine`.
pub fn closest<'a>(
    wanted: &str,
    candidates: impl IntoIterator<Item = &'a str>,
    n: usize,
) -> Vec<&'a str> {
    let norm = |s: &str| -> Vec<char> {
        s.chars()
            .filter(|c| !matches!(c, '-' | '_' | ' '))
            .flat_map(char::to_lowercase)
            .collect()
    };
    let w = norm(wanted);
    if w.is_empty() {
        return vec![];
    }
    let max_typos = (w.len() / 3).clamp(1, 3);
    let mut scored: Vec<(usize, usize, &str)> = candidates
        .into_iter()
        .filter_map(|c| {
            let cn = norm(c);
            if contains(&cn, &w) {
                return Some((0, cn.len() - w.len(), c));
            }
            // Compare against the whole name and against its leading part, so a
            // typo in a prefix ("catpucin") still finds "catppuccin-mocha".
            let lo = w.len().saturating_sub(1);
            let prefix = (lo..=w.len() + 2)
                .map(|len| distance(&w, &cn[..cn.len().min(len)]))
                .min()
                .unwrap_or(usize::MAX);
            let d = distance(&w, &cn).min(prefix);
            (d <= max_typos).then_some((1, d, c))
        })
        .collect();
    scored.sort();
    scored.into_iter().take(n).map(|(_, _, c)| c).collect()
}

fn contains(hay: &[char], needle: &[char]) -> bool {
    hay.windows(needle.len()).any(|w| w == needle)
}

/// Optimal string alignment distance (Levenshtein plus adjacent swaps).
fn distance(a: &[char], b: &[char]) -> usize {
    let (n, m) = (a.len(), b.len());
    let mut d = vec![vec![0usize; m + 1]; n + 1];
    for (i, row) in d.iter_mut().enumerate() {
        row[0] = i;
    }
    d[0] = (0..=m).collect();
    for i in 1..=n {
        for j in 1..=m {
            let cost = usize::from(a[i - 1] != b[j - 1]);
            d[i][j] = (d[i - 1][j] + 1)
                .min(d[i][j - 1] + 1)
                .min(d[i - 1][j - 1] + cost);
            if i > 1 && j > 1 && a[i - 1] == b[j - 2] && a[i - 2] == b[j - 1] {
                d[i][j] = d[i][j].min(d[i - 2][j - 2] + 1);
            }
        }
    }
    d[n][m]
}

#[cfg(test)]
mod tests {
    use super::*;

    const NAMES: &[&str] = &[
        "rose-pine",
        "rose-pine-dawn",
        "catppuccin-mocha",
        "gruvbox-dark-hard",
        "nord",
        "dracula",
    ];

    #[test]
    fn finds_typos_and_missing_dashes() {
        assert_eq!(
            closest("rosepine", NAMES.iter().copied(), 3),
            ["rose-pine", "rose-pine-dawn"]
        );
        assert_eq!(closest("draculla", NAMES.iter().copied(), 3), ["dracula"]);
        assert_eq!(
            closest("catpucin", NAMES.iter().copied(), 3),
            ["catppuccin-mocha"]
        );
        assert_eq!(closest("nrod", NAMES.iter().copied(), 3), ["nord"]);
    }

    #[test]
    fn nothing_for_unrelated_names() {
        assert!(closest("solarized", NAMES.iter().copied(), 3).is_empty());
    }
}
