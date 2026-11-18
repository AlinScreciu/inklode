//! `graph.note` and `graph.path`: questions about the links between notes, answered
//! from lists of who links to whom that are built once per call.

use std::collections::VecDeque;

use serde::Serialize;

use crate::Error;
use crate::index::Index;

/// The most notes `near` lists. A hub three links away from everything would
/// otherwise put the whole vault in one answer; `near_total` says how many there are.
const NEAR_MAX: usize = 200;

/// The result of `graph.note`.
#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NoteGraph {
    pub path: String,
    /// The notes it links to or embeds, by path.
    pub links: Vec<String>,
    /// The notes that link to it or embed it, by path.
    pub backlinks: Vec<String>,
    /// The targets of its links that reach no note and no file, as written.
    pub unresolved: Vec<String>,
    /// With a depth above 1: the notes 2 to `depth` links away, nearest first, then by path.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub near: Option<Vec<Near>>,
    /// How many notes are that near, which is more than `near` holds when it was cut.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub near_total: Option<usize>,
}

#[derive(Debug, Serialize, PartialEq)]
pub struct Near {
    pub path: String,
    /// The fewest links between the two notes, whichever way each link points.
    pub distance: usize,
}

/// The result of `graph.path`.
#[derive(Debug, Serialize, PartialEq)]
pub struct Route {
    /// False when no chain of links joins the two notes; `path` and `steps` are then empty.
    pub found: bool,
    /// The notes of the chain, from the first to the last.
    pub path: Vec<String>,
    /// One per pair of neighbours in `path`.
    pub steps: Vec<Step>,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Step {
    pub from: String,
    pub to: String,
    /// The note that holds the link: `from`, or `to` when only `to` links to `from`.
    pub link_in: String,
}

/// Who links to whom, by position in the index's order of paths.
struct Links<'a> {
    paths: Vec<&'a str>,
    out: Vec<Vec<usize>>,
    back: Vec<Vec<usize>>,
}

impl<'a> Links<'a> {
    fn of(index: &'a Index) -> Self {
        let out = index.adjacency();
        let mut back = vec![Vec::new(); out.len()];
        // `from` goes up, so each list of `back` comes out sorted.
        for (from, to) in out.iter().enumerate().flat_map(|(from, to)| to.iter().map(move |to| (from, *to))) {
            back[to].push(from);
        }
        Self { paths: index.paths().collect(), out, back }
    }

    fn at(&self, path: &str) -> Result<usize, Error> {
        self.paths.binary_search(&path).map_err(|_| Error::NotFound(path.to_string()))
    }

    fn named(&self, notes: &[usize]) -> Vec<String> {
        notes.iter().map(|at| self.paths[*at].to_string()).collect()
    }

    /// The notes one link away from `at`, in either direction. One that links both ways comes twice.
    fn beside(&self, at: usize) -> impl Iterator<Item = usize> + '_ {
        self.out[at].iter().chain(&self.back[at]).copied()
    }

    /// For each note, the fewest links from `start` to it and the note before it on such a
    /// way, for the notes up to `depth` links away, stopping early once `goal` is reached.
    fn reach(&self, start: usize, depth: usize, goal: Option<usize>) -> Vec<Option<(usize, usize)>> {
        let mut seen: Vec<Option<(usize, usize)>> = vec![None; self.paths.len()];
        seen[start] = Some((0, start));
        let mut queue = VecDeque::from([start]);
        while let Some(at) = queue.pop_front() {
            let distance = seen[at].expect("queued notes are seen").0;
            if distance == depth || Some(at) == goal {
                continue;
            }
            for next in self.beside(at) {
                if seen[next].is_none() {
                    seen[next] = Some((distance + 1, at));
                    queue.push_back(next);
                }
            }
        }
        seen
    }
}

/// `graph.note`: what the note at `path` links to, what links to it, and with a
/// `depth` above 1 the notes further away.
pub fn note(index: &Index, path: &str, depth: usize) -> Result<NoteGraph, Error> {
    let links = Links::of(index);
    let at = links.at(path)?;
    let mut graph = NoteGraph {
        path: path.to_string(),
        links: links.named(&links.out[at]),
        backlinks: links.named(&links.back[at]),
        unresolved: index.unresolved(path),
        near: None,
        near_total: None,
    };
    if depth > 1 {
        let seen = links.reach(at, depth, None);
        let far = seen.iter().enumerate().filter_map(|(note, seen)| Some((seen.as_ref()?.0, note))).filter(|(distance, _)| *distance > 1);
        let mut near: Vec<(usize, usize)> = far.collect();
        // Positions are in path order, so this is by distance, then path.
        near.sort_unstable();
        graph.near_total = Some(near.len());
        let near = near.into_iter().take(NEAR_MAX);
        graph.near = Some(near.map(|(distance, note)| Near { path: links.paths[note].to_string(), distance }).collect());
    }
    Ok(graph)
}

/// `graph.path`: a shortest chain of notes from `from` to `to`, each joined to the
/// next by a link in one of the two.
pub fn path(index: &Index, from: &str, to: &str) -> Result<Route, Error> {
    let links = Links::of(index);
    let (start, goal) = (links.at(from)?, links.at(to)?);
    let seen = links.reach(start, usize::MAX, Some(goal));
    if seen[goal].is_none() {
        return Ok(Route { found: false, path: Vec::new(), steps: Vec::new() });
    }
    let mut chain = vec![goal];
    while let Some(&last) = chain.last().filter(|last| **last != start) {
        chain.push(seen[last].expect("a note on the way was seen").1);
    }
    chain.reverse();
    let step = |pair: &[usize]| {
        let (from, to) = (pair[0], pair[1]);
        let holder = if links.out[from].binary_search(&to).is_ok() { from } else { to };
        Step { from: links.paths[from].to_string(), to: links.paths[to].to_string(), link_in: links.paths[holder].to_string() }
    };
    Ok(Route { found: true, path: links.named(&chain), steps: chain.windows(2).map(step).collect() })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn vault() -> Index {
        Index::of(&[
            ("Home.md", "[[a]] [[A|again]] [[Home]] [[#Top]] [[Missing]] [[missing#x|y]] ![[pic.png]] ![[gone.png]] `[[Lone]]`\n"),
            ("sub/a.md", "back [[Home]], embed ![[b#Part]]\n"),
            ("sub/b.md", "[[c]]\n"),
            ("c.md", "[[d]]\n"),
            ("d.md", ""),
            ("Lone.md", ""),
            ("Fan.md", "[[d]]\n"),
            ("pic.png", ""),
        ])
    }

    fn near(list: &[(&str, usize)]) -> Option<Vec<Near>> {
        Some(list.iter().map(|(path, distance)| Near { path: path.to_string(), distance: *distance }).collect())
    }

    #[test]
    fn a_note_has_its_links_its_backlinks_and_the_targets_that_name_nothing() {
        let index = vault();
        let home = note(&index, "Home.md", 1).unwrap();
        // Aliases, headings, repeats and the note's own name make one link; code makes none.
        assert_eq!(home.links, ["sub/a.md"]);
        assert_eq!(home.backlinks, ["sub/a.md"]);
        // An embed of a file that is there is not unresolved; one name is listed once, as first written.
        assert_eq!(home.unresolved, ["Missing", "gone.png"]);
        assert_eq!((home.near, home.near_total), (None, None));

        let a = note(&index, "sub/a.md", 1).unwrap();
        assert_eq!((a.links, a.backlinks, a.unresolved), (vec!["Home.md".to_string(), "sub/b.md".to_string()], vec!["Home.md".to_string()], vec![]));
        let lone = note(&index, "Lone.md", 3).unwrap();
        assert_eq!((lone.links.len(), lone.backlinks.len(), lone.near, lone.near_total), (0, 0, near(&[]), Some(0)));
        assert!(matches!(note(&index, "Nope.md", 1), Err(Error::NotFound(path)) if path == "Nope.md"));
    }

    #[test]
    fn near_lists_the_notes_further_away_with_their_distance_in_either_direction() {
        let index = vault();
        assert_eq!(note(&index, "Home.md", 2).unwrap().near, near(&[("sub/b.md", 2)]));
        let far = note(&index, "Home.md", 3).unwrap();
        assert_eq!(far.near, near(&[("sub/b.md", 2), ("c.md", 3)]));
        assert_eq!(far.near_total, Some(2));
        // Against the links (d from c) and along them (d to nothing, Fan to d).
        assert_eq!(note(&index, "d.md", 3).unwrap().near, near(&[("sub/b.md", 2), ("sub/a.md", 3)]));
        assert_eq!(note(&index, "Fan.md", 2).unwrap().near, near(&[("c.md", 2)]));
    }

    #[test]
    fn near_is_cut_and_says_how_many_there_are() {
        let leaves: Vec<(String, String)> = (0..NEAR_MAX + 50).map(|i| (format!("leaf{i:03}.md"), "[[Hub]]\n".to_string())).collect();
        let mut notes: Vec<(&str, &str)> = leaves.iter().map(|(path, text)| (path.as_str(), text.as_str())).collect();
        notes.extend([("Hub.md", ""), ("Start.md", "[[Hub]]\n")]);
        let start = note(&Index::of(&notes), "Start.md", 2).unwrap();
        assert_eq!((start.near.unwrap().len(), start.near_total), (NEAR_MAX, Some(NEAR_MAX + 50)));
    }

    #[test]
    fn a_path_is_the_shortest_chain_and_says_which_note_holds_each_link() {
        let index = vault();
        let step = |from: &str, to: &str, link_in: &str| Step { from: from.to_string(), to: to.to_string(), link_in: link_in.to_string() };
        let route = path(&index, "Home.md", "Fan.md").unwrap();
        assert!(route.found);
        assert_eq!(route.path, ["Home.md", "sub/a.md", "sub/b.md", "c.md", "d.md", "Fan.md"]);
        assert_eq!(route.steps[0], step("Home.md", "sub/a.md", "Home.md"));
        // The last link is written in Fan, so the step is walked against it.
        assert_eq!(route.steps[4], step("d.md", "Fan.md", "Fan.md"));
        // The other way round, the same chain backwards.
        let back = path(&index, "Fan.md", "Home.md").unwrap();
        assert_eq!(back.path, ["Fan.md", "d.md", "c.md", "sub/b.md", "sub/a.md", "Home.md"]);
        assert_eq!(back.steps[0], step("Fan.md", "d.md", "Fan.md"));
        assert_eq!(back.steps[4], step("sub/a.md", "Home.md", "sub/a.md"));

        assert_eq!(path(&index, "Home.md", "Home.md").unwrap(), Route { found: true, path: vec!["Home.md".to_string()], steps: vec![] });
        assert_eq!(path(&index, "Home.md", "Lone.md").unwrap(), Route { found: false, path: vec![], steps: vec![] });
        assert!(matches!(path(&index, "Home.md", "Nope.md"), Err(Error::NotFound(_))));
    }

    #[test]
    fn a_shortcut_beats_a_longer_chain() {
        let index = Index::of(&[("a.md", "[[b]]\n"), ("b.md", "[[c]]\n"), ("c.md", "[[d]]\n"), ("d.md", "[[a]]\n")]);
        assert_eq!(path(&index, "a.md", "d.md").unwrap().path, ["a.md", "d.md"]);
        assert_eq!(path(&index, "a.md", "c.md").unwrap().path.len(), 3);
    }
}
