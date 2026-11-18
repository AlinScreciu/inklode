//! `search.ranked`: the notes a query is about, best first.
//!
//! Each note is scored with BM25 over the words of its text, and a query word that
//! is in the note's file name, its frontmatter `aliases` or `tags`, or a heading adds
//! to that. Words are compared whole and without case: no stemming, nothing fuzzy.

use serde::Serialize;

use crate::index::{Index, clip, unfenced};

/// BM25's usual constants: how fast repeats of a word stop counting, and how much a
/// long note is held back.
const K1: f64 = 1.2;
const B: f64 = 0.75;

/// What a query word in a field adds, in the unit of a word's count in the text. That
/// count is below `K1 + 1` (2.2) however often the word is written, so a word in the
/// name outweighs any number of mentions, and the fields add up.
const IN_NAME: f64 = 3.0;
const IN_ALIAS: f64 = 3.0;
const IN_TAG: f64 = 2.0;
const IN_HEADING: f64 = 1.5;

/// How many lines of a note are shown with it.
const LINES: usize = 3;

/// One note of `search.ranked`.
#[derive(Debug, Serialize, PartialEq)]
pub struct Ranked {
    pub path: String,
    /// Higher is better, and only comparable within one answer. Rounded to 3 decimals.
    pub score: f64,
    /// The lines with the most of the query in them, at most 3, in the order of the
    /// note. Empty when only the file name matched.
    pub lines: Vec<Line>,
}

#[derive(Debug, Serialize, PartialEq)]
pub struct Line {
    /// 1-based.
    pub line: usize,
    pub text: String,
}

/// What one note has of the query: per query word, how often it is in the text and
/// what the fields add for it.
struct Found {
    words: usize,
    counts: Vec<usize>,
    fields: Vec<f64>,
}

/// The `limit` notes that match `query` best. A note needs one of the query's words;
/// those that have all of them come before the others, then the higher score, then the path.
// shortcut: reads every word of every note per query (40 ms for 3000 notes of 20 MB
// together), fine for a few thousand notes; keep the word counts per note in the index
// when that gets slow.
// shortcut: a word is a run of letters and digits, so text in a script written without
// spaces is one word per run; split such text properly when a vault needs it.
pub fn search(index: &Index, query: &str, limit: usize) -> Vec<Ranked> {
    let query = query.to_lowercase();
    let mut terms: Vec<&str> = Vec::new();
    for word in words(&query) {
        if !terms.contains(&word) {
            terms.push(word);
        }
    }
    if terms.is_empty() {
        return Vec::new();
    }

    let notes: Vec<(&str, &str)> = index.texts().collect();
    let found: Vec<Found> = notes.iter().map(|(path, text)| find(path, &text.to_lowercase(), &terms)).collect();
    let has = |found: &Found, term: usize| found.counts[term] > 0 || found.fields[term] > 0.0;

    // A word that few notes have says more about a note than one that most have.
    let total = notes.len() as f64;
    let weights: Vec<f64> = (0..terms.len())
        .map(|term| {
            let with = found.iter().filter(|found| has(found, term)).count() as f64;
            (1.0 + (total - with + 0.5) / (with + 0.5)).ln()
        })
        .collect();
    let average = (found.iter().map(|found| found.words).sum::<usize>() as f64 / total).max(1.0);
    let score = |found: &Found| -> f64 {
        let length = K1 * (1.0 - B + B * found.words as f64 / average);
        (0..terms.len())
            .map(|term| {
                let count = found.counts[term] as f64;
                weights[term] * (count * (K1 + 1.0) / (count + length) + found.fields[term])
            })
            .sum()
    };

    let mut best: Vec<(bool, f64, usize)> = found
        .iter()
        .enumerate()
        .filter(|(_, found)| (0..terms.len()).any(|term| has(found, term)))
        .map(|(note, found)| ((0..terms.len()).all(|term| has(found, term)), score(found), note))
        .collect();
    // Notes are in path order, so the position settles a tie by path.
    best.sort_by(|a, b| b.0.cmp(&a.0).then(b.1.total_cmp(&a.1)).then(a.2.cmp(&b.2)));
    best.truncate(limit);
    best.into_iter()
        .map(|(_, score, note)| Ranked {
            path: notes[note].0.to_string(),
            score: (score * 1000.0).round() / 1000.0,
            lines: lines(notes[note].1, &terms, &weights),
        })
        .collect()
}

/// The words of a text: its runs of letters and digits.
fn words(text: &str) -> impl Iterator<Item = &str> {
    text.split(|c: char| !c.is_alphanumeric()).filter(|word| !word.is_empty())
}

/// Counts the query's `terms` in a note. `text` is the note's text in lowercase, as the terms are.
fn find(path: &str, text: &str, terms: &[&str]) -> Found {
    let mut found = Found { words: 0, counts: vec![0; terms.len()], fields: vec![0.0; terms.len()] };
    for word in words(text) {
        found.words += 1;
        if let Some(term) = terms.iter().position(|term| *term == word) {
            found.counts[term] += 1;
        }
    }
    let name = path.rsplit('/').next().unwrap_or(path).to_lowercase();
    let name = name.strip_suffix(".md").unwrap_or(&name);
    let (aliases, tags) = meta(text);
    let headings: String = unfenced(text).filter_map(|(_, _, line)| heading(line)).collect();
    for (field, adds) in [(name, IN_NAME), (aliases.as_str(), IN_ALIAS), (tags.as_str(), IN_TAG), (headings.as_str(), IN_HEADING)] {
        for (term, sum) in terms.iter().zip(&mut found.fields) {
            if words(field).any(|word| word == *term) {
                *sum += adds;
            }
        }
    }
    found
}

/// The text of a heading line (`# Title` to `###### Title`), still with its line end. `None` for any other line.
fn heading(line: &str) -> Option<&str> {
    let title = line.trim_start().trim_start_matches('#');
    let hashes = line.trim_start().len() - title.len();
    ((1..=6).contains(&hashes) && title.starts_with([' ', '\t'])).then_some(title)
}

/// The values of `aliases` and of `tags` in a note's frontmatter, each as one text to take
/// the words of. Read line by line as health.rs reads `repos`, not as full YAML:
/// `key: value`, `key: [a, b]` and `- item` lines under the key, without a trailing `# comment`.
pub(crate) fn meta(text: &str) -> (String, String) {
    let (mut aliases, mut tags) = (String::new(), String::new());
    let mut lines = text.lines();
    if lines.next().map(str::trim_end) != Some("---") {
        return (aliases, tags);
    }
    let mut key = "";
    for line in lines {
        if line.trim_end() == "---" {
            return (aliases, tags);
        }
        let named = line.split_once(':').filter(|(name, _)| !name.is_empty() && name.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-'));
        let value = match named {
            Some((name, value)) => {
                key = name;
                value
            }
            None if line.trim_start().starts_with('-') => line,
            None => continue,
        };
        let value = value.find(" #").map_or(value, |at| &value[..at]);
        match key {
            "aliases" => aliases.extend([value, "\n"]),
            "tags" => tags.extend([value, "\n"]),
            _ => {}
        }
    }
    // Without the closing `---` the note has no frontmatter.
    (String::new(), String::new())
}

/// The lines of a note that say most of the query: by the weight of the query words on
/// the line, each counted once, and the earlier line of two that are equal.
fn lines(text: &str, terms: &[&str], weights: &[f64]) -> Vec<Line> {
    let mut best: Vec<(f64, usize, &str)> = Vec::new();
    for (at, line) in text.lines().enumerate() {
        let lower = line.to_lowercase();
        let weight: f64 = terms.iter().zip(weights).filter(|(term, _)| words(&lower).any(|word| word == **term)).map(|(_, weight)| weight).sum();
        if weight > 0.0 {
            best.push((weight, at + 1, line));
        }
    }
    best.sort_by(|a, b| b.0.total_cmp(&a.0).then(a.1.cmp(&b.1)));
    best.truncate(LINES);
    best.sort_by_key(|(_, line, _)| *line);
    best.into_iter().map(|(_, line, text)| Line { line, text: clip(text) }).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn paths(found: &[Ranked]) -> Vec<&str> {
        found.iter().map(|note| note.path.as_str()).collect()
    }

    #[test]
    fn a_note_about_the_query_comes_before_one_that_mentions_it() {
        let filler = "nothing of interest here at all\n".repeat(20);
        let index = Index::of(&[
            ("about.md", "Backups run nightly. A backup is kept for a week, and each BACKUP is checked.\n"),
            ("mention.md", &format!("{filler}one backup line\n{filler}")),
            ("other.md", "no such word, and backups is another word, as is backup2\n"),
        ]);
        let found = search(&index, "Backup", 10);
        assert_eq!(paths(&found), ["about.md", "mention.md"]);
        assert!(found[0].score > found[1].score);
        assert_eq!(found[0].lines, [Line { line: 1, text: "Backups run nightly. A backup is kept for a week, and each BACKUP is checked.".to_string() }]);
        assert_eq!(found[1].lines, [Line { line: 21, text: "one backup line".to_string() }]);
        // Case is ignored outside ASCII too, and a letter with a mark is another letter.
        let marks = Index::of(&[("a.md", "Über ÉCOLE\n"), ("b.md", "uber ecole\n")]);
        assert_eq!(paths(&search(&marks, "über école", 10)), ["a.md"]);
        assert_eq!(paths(&search(&marks, "UBER", 10)), ["b.md"]);
        assert!(search(&index, "", 10).is_empty());
        assert!(search(&index, " -- !", 10).is_empty());
        assert!(search(&index, "zebra", 10).is_empty());
    }

    #[test]
    fn the_name_aliases_tags_and_headings_count_for_more_than_the_text() {
        let text = "the release was mentioned, release after release, release upon release\n";
        let index = Index::of(&[
            ("text.md", text),
            ("heading.md", "## The Release plan\nwords words words words words words words words\n"),
            ("tag.md", "---\ntags:\n  - Release\n---\nwords words words words words words words words\n"),
            ("alias.md", "---\naliases: [\"Release notes\", other]\n---\nwords words words words words words words\n"),
            ("deep/Release.md", "words words words words words words words words words words\n"),
            // Not a heading, and not frontmatter: no closing line, and a fence.
            ("plain.md", "#release in a line\n```\n# release\n```\n"),
            ("open.md", "---\ntags: [release]\n\nwords\n"),
        ]);
        let found = search(&index, "release", 10);
        let score = |path: &str| found.iter().find(|note| note.path == path).unwrap().score;
        assert!(score("deep/Release.md") > score("text.md"), "{found:?}");
        assert!(score("alias.md") > score("text.md"), "{found:?}");
        assert!(score("tag.md") > score("text.md"), "{found:?}");
        assert!(score("heading.md") > score("text.md"), "{found:?}");
        for path in ["plain.md", "open.md"] {
            assert!(score(path) < score("heading.md"), "{path}: {found:?}");
        }
        // Found by its name alone, a note has no line to show.
        assert!(found.iter().find(|note| note.path == "deep/Release.md").unwrap().lines.is_empty());
    }

    #[test]
    fn a_note_with_every_word_comes_before_a_note_with_some() {
        let index = Index::of(&[
            ("Tokens.md", "# Tokens\ntokens tokens tokens\n"),
            ("both.md", "long text that says rotate once and, much later, tokens once, among many other words\n"),
            ("rotate.md", "rotate\n"),
        ]);
        let found = search(&index, "rotate tokens", 10);
        assert_eq!(paths(&found), ["both.md", "Tokens.md", "rotate.md"]);
        // The name and heading give the second note the higher score; having both words still goes first.
        assert!(found[1].score > found[0].score);
        assert_eq!(paths(&search(&index, "rotate tokens", 1)), ["both.md"]);
        // A word written twice in the query is one word.
        assert_eq!(search(&index, "tokens TOKENS", 10)[0].score, search(&index, "tokens", 10)[0].score);
    }

    #[test]
    fn the_lines_shown_are_the_three_that_say_most_in_note_order() {
        let long = format!("alpha {}", "x".repeat(300));
        let index = Index::of(&[("a.md", &format!("alpha\nnothing\nbeta\n  alpha and beta  \nalpha\nbeta alpha\n{long}\n")), ("b.md", "beta\n")]);
        let found = search(&index, "alpha beta", 10);
        let shown: Vec<(usize, &str)> = found[0].lines.iter().map(|line| (line.line, line.text.as_str())).collect();
        // The two lines with both words, then the first of those with the word fewer notes have.
        assert_eq!(shown, [(1, "alpha"), (4, "alpha and beta"), (6, "beta alpha")]);
        let cut = search(&Index::of(&[("a.md", &long)]), "alpha", 10);
        assert_eq!(cut[0].lines[0].text.chars().count(), 200);
    }
}
