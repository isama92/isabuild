//! Enumerating the installed monospace fonts for the settings window.
//!
//! A webview cannot list installed fonts on all three platforms (the Local Font
//! Access API is Chromium-only, so it is missing in WKWebView on macOS), and the
//! whole point of the setting is choosing a Nerd Font whose exact family name
//! the user would otherwise have to know by heart. So the list comes from Rust.
//!
//! `fontdb` rather than `font-kit`: it is pure Rust, so the Linux CI job needs
//! no `libfontconfig1-dev`, and it exposes the `monospaced` flag straight from
//! the font tables, which is what lets the picker default to mono families.

use std::collections::HashMap;
use std::sync::OnceLock;

use serde::Serialize;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FontFamily {
    /// Family name exactly as CSS and xterm need it.
    pub name: String,
    /// Whether the font declares itself fixed-pitch. The settings window filters
    /// on this by default; a proportional font in a terminal is unusable.
    pub monospaced: bool,
}

/// Scanning parses every installed font file, which is slow enough to notice on
/// a machine with a large collection. The set does not change while the app
/// runs often enough to be worth rescanning, so it is read once per process;
/// a font installed afterwards needs a restart to appear.
static CACHE: OnceLock<Vec<FontFamily>> = OnceLock::new();

/// Every installed family, deduplicated and sorted. Blocking: run it off the
/// async runtime's worker threads.
pub fn families() -> &'static [FontFamily] {
    CACHE.get_or_init(|| {
        let mut db = fontdb::Database::new();
        db.load_system_fonts();
        // The first family name is English US where the font provides one, which
        // is the name CSS and xterm expect.
        collect(db.faces().filter_map(|face| {
            face.families
                .first()
                .map(|(name, _)| (name.as_str(), face.monospaced))
        }))
    })
}

/// Fold per-face rows into per-family ones.
///
/// A family is monospaced if **any** of its faces says so: fonts commonly leave
/// the flag off an italic or a variable face, and dropping the whole family for
/// that would hide exactly the Nerd Fonts this setting exists to find.
fn collect<'a>(faces: impl Iterator<Item = (&'a str, bool)>) -> Vec<FontFamily> {
    // Keyed rather than scanned: a machine with a large collection has
    // thousands of faces, and the linear search this replaces was quadratic in
    // that. It is cached for the process either way, but there is no reason for
    // the one scan to be slow.
    let mut by_name: HashMap<&str, bool> = HashMap::new();
    for (name, monospaced) in faces {
        let name = name.trim();
        if name.is_empty() {
            continue;
        }
        let entry = by_name.entry(name).or_insert(false);
        *entry |= monospaced;
    }
    let mut families: Vec<FontFamily> = by_name
        .into_iter()
        .map(|(name, monospaced)| FontFamily {
            name: name.to_string(),
            monospaced,
        })
        .collect();
    // Case-insensitive so the select does not read as two alphabets interleaved.
    families.sort_by_key(|family| family.name.to_lowercase());
    families
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn faces_of_one_family_collapse_into_a_single_entry() {
        let collected = collect([("JetBrains Mono", true), ("JetBrains Mono", true)].into_iter());
        assert_eq!(
            collected,
            vec![FontFamily {
                name: "JetBrains Mono".into(),
                monospaced: true
            }]
        );
    }

    #[test]
    fn a_family_is_monospaced_if_any_face_says_so() {
        // Italic and variable faces often drop the fixed-pitch flag; the family
        // is still the one the user means by "JetBrains Mono".
        let collected = collect([("JetBrains Mono", false), ("JetBrains Mono", true)].into_iter());
        assert_eq!(collected.len(), 1);
        assert!(collected[0].monospaced);
    }

    #[test]
    fn families_are_sorted_case_insensitively() {
        let collected = collect(
            [
                ("ubuntu Mono", true),
                ("Anonymous Pro", true),
                ("Zed Mono", true),
            ]
            .into_iter(),
        );
        let names: Vec<&str> = collected.iter().map(|f| f.name.as_str()).collect();
        assert_eq!(names, vec!["Anonymous Pro", "ubuntu Mono", "Zed Mono"]);
    }

    #[test]
    fn a_blank_family_name_is_dropped() {
        let collected = collect([("   ", true), ("Fira Code", true)].into_iter());
        assert_eq!(collected.len(), 1);
        assert_eq!(collected[0].name, "Fira Code");
    }

    #[test]
    fn a_family_name_is_trimmed() {
        let collected = collect([(" Fira Code ", true), ("Fira Code", false)].into_iter());
        assert_eq!(
            collected,
            vec![FontFamily {
                name: "Fira Code".into(),
                monospaced: true
            }],
            "a padded name is the same family, not a second one"
        );
    }
}
