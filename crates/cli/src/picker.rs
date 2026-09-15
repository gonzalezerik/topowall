//! `topowall preview` without a name: browse the built-in color schemes with a
//! live map preview, and pick one with Enter.
//!
//! The picker draws on stderr (so stdout stays free for the chosen flags, e.g.
//! `topowall render map.topo $(topowall preview) -o out.png`) and reads keys from
//! the terminal.

use crate::terminal;
use anyhow::{bail, Context, Result};
use crossterm::{
    cursor,
    event::{self, Event, KeyCode, KeyEvent, KeyEventKind, KeyModifiers},
    execute, queue,
    style::{Attribute, Print, SetAttribute},
    terminal::{self as term, ClearType},
};
use std::{
    io::{IsTerminal, Write},
    time::Duration,
};
use topowall_render::{palette, tags::Entry};

/// How palette colors become line colors, cycled with Tab.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Style {
    Subtle,
    Vivid,
    Mono,
}

impl Style {
    pub fn name(self) -> &'static str {
        match self {
            Style::Subtle => "subtle",
            Style::Vivid => "vivid",
            Style::Mono => "mono",
        }
    }

    fn next(self) -> Self {
        match self {
            Style::Subtle => Style::Vivid,
            Style::Vivid => Style::Mono,
            Style::Mono => Style::Subtle,
        }
    }
}

/// What the person picked.
#[derive(Clone, Debug)]
pub struct Choice {
    pub palette: String,
    pub style: Style,
    pub black_background: bool,
}

/// Draws one preview: the chosen scheme on the map, `cols` by `rows` cells,
/// as rows of RGB pixels (two per cell, stacked).
pub type Draw<'a> = dyn FnMut(&Choice, usize, usize) -> Result<Vec<[u8; 3]>> + 'a;

const LIST_WIDTH: usize = 30;

struct Screen;

impl Screen {
    fn enter() -> Result<Self> {
        term::enable_raw_mode().context("switching the terminal to raw mode")?;
        let mut err = std::io::stderr();
        execute!(
            err,
            term::EnterAlternateScreen,
            cursor::Hide,
            term::Clear(ClearType::All)
        )?;
        Ok(Screen)
    }
}

impl Drop for Screen {
    fn drop(&mut self) {
        let mut err = std::io::stderr();
        let _ = execute!(err, cursor::Show, term::LeaveAlternateScreen);
        let _ = term::disable_raw_mode();
    }
}

struct State<'a> {
    all: &'a [Entry],
    query: String,
    shown: Vec<usize>,
    selected: usize,
    scroll: usize,
    style: Style,
    black: bool,
}

impl State<'_> {
    fn filter(&mut self) {
        let current = self.shown.get(self.selected).copied();
        // Every word must appear in the name, the title or the tags, so
        // "dark cool" and "gruv hard" both work. Dashes and case are ignored.
        let squash = |s: &str| {
            s.chars()
                .filter(|c| c.is_alphanumeric() || *c == ' ')
                .flat_map(char::to_lowercase)
                .collect::<String>()
        };
        let words: Vec<String> = self
            .query
            .split_whitespace()
            .map(|w| squash(w).replace(' ', ""))
            .filter(|w| !w.is_empty())
            .collect();
        self.shown = self
            .all
            .iter()
            .enumerate()
            .filter(|(_, e)| {
                let hay = format!(
                    "{} {} {}",
                    squash(&e.name.replace('-', "")),
                    squash(&e.title),
                    e.tags.join(" ")
                );
                words.iter().all(|w| hay.contains(w.as_str()))
            })
            .map(|(i, _)| i)
            .collect();
        self.selected = current
            .and_then(|c| self.shown.iter().position(|&i| i == c))
            .unwrap_or(0);
    }

    fn entry(&self) -> Option<&Entry> {
        self.shown.get(self.selected).map(|&i| &self.all[i])
    }

    fn choice(&self) -> Option<Choice> {
        self.entry().map(|e| Choice {
            palette: e.name.clone(),
            style: self.style,
            black_background: self.black,
        })
    }

    fn move_by(&mut self, delta: isize) {
        if self.shown.is_empty() {
            return;
        }
        let last = self.shown.len() as isize - 1;
        self.selected = (self.selected as isize + delta).clamp(0, last) as usize;
    }
}

/// Run the picker. Returns `None` if the person quits without choosing.
pub fn run(
    start: Option<&str>,
    style: Style,
    black: bool,
    draw: &mut Draw,
) -> Result<Option<Choice>> {
    if !std::io::stdin().is_terminal() || !std::io::stderr().is_terminal() {
        bail!("the interactive preview needs a terminal; give a scheme name instead, e.g. `topowall preview rose-pine`");
    }
    let all = topowall_render::tags::catalog();
    let mut state = State {
        all,
        query: String::new(),
        shown: (0..all.len()).collect(),
        selected: 0,
        scroll: 0,
        style,
        black,
    };
    if let Some(name) = start {
        if let Some(i) = all.iter().position(|e| e.name == name) {
            state.selected = i;
        }
    }

    let _screen = Screen::enter()?;
    let mut dirty = true;
    loop {
        if dirty {
            render(&mut state, draw)?;
            dirty = false;
        }
        // Handle every key already waiting before drawing again, so holding an
        // arrow key doesn't queue up previews.
        let mut first = true;
        while event::poll(if first {
            Duration::from_millis(500)
        } else {
            Duration::ZERO
        })? {
            first = false;
            match event::read()? {
                Event::Key(key) if key.kind != KeyEventKind::Release => {
                    match handle(&mut state, key) {
                        Action::Redraw => dirty = true,
                        Action::Quit => return Ok(None),
                        Action::Pick => {
                            if let Some(choice) = state.choice() {
                                return Ok(Some(choice));
                            }
                        }
                        Action::None => {}
                    }
                }
                Event::Resize(..) => {
                    execute!(std::io::stderr(), term::Clear(ClearType::All))?;
                    dirty = true;
                }
                _ => {}
            }
        }
    }
}

enum Action {
    None,
    Redraw,
    Pick,
    Quit,
}

fn handle(s: &mut State, key: KeyEvent) -> Action {
    let ctrl = key.modifiers.contains(KeyModifiers::CONTROL);
    match key.code {
        KeyCode::Char('c') if ctrl => Action::Quit,
        KeyCode::Char('b') if ctrl => {
            s.black = !s.black;
            Action::Redraw
        }
        KeyCode::Esc if !s.query.is_empty() => {
            s.query.clear();
            s.filter();
            Action::Redraw
        }
        KeyCode::Esc => Action::Quit,
        KeyCode::Enter => Action::Pick,
        KeyCode::Up => {
            s.move_by(-1);
            Action::Redraw
        }
        KeyCode::Down => {
            s.move_by(1);
            Action::Redraw
        }
        KeyCode::PageUp => {
            s.move_by(-10);
            Action::Redraw
        }
        KeyCode::PageDown => {
            s.move_by(10);
            Action::Redraw
        }
        KeyCode::Home => {
            s.selected = 0;
            Action::Redraw
        }
        KeyCode::End => {
            s.selected = s.shown.len().saturating_sub(1);
            Action::Redraw
        }
        KeyCode::Tab => {
            s.style = s.style.next();
            Action::Redraw
        }
        KeyCode::BackTab => {
            s.black = !s.black;
            Action::Redraw
        }
        KeyCode::Backspace => {
            s.query.pop();
            s.filter();
            Action::Redraw
        }
        KeyCode::Char(c) if !ctrl && s.query.len() < 40 => {
            s.query.push(c);
            s.filter();
            Action::Redraw
        }
        _ => Action::None,
    }
}

/// Cut or pad `text` to exactly `width` terminal columns (the text is ASCII or close to it).
fn fit(text: &str, width: usize) -> String {
    let mut out: String = text.chars().take(width).collect();
    let len = out.chars().count();
    out.extend(std::iter::repeat_n(' ', width - len));
    out
}

fn render(s: &mut State, draw: &mut Draw) -> Result<()> {
    let (w, h) = term::size()?;
    let (w, h) = (w as usize, h as usize);
    let mut out = std::io::stderr().lock();
    queue!(out, cursor::MoveTo(0, 0))?;
    if w < LIST_WIDTH + 24 || h < 10 {
        queue!(
            out,
            Print(fit(
                "Make the terminal larger to see the preview (Esc to quit).",
                w
            ))
        )?;
        out.flush()?;
        return Ok(());
    }

    let body = h - 3; // header, info line, key help
    let (cols, rows) = (w - LIST_WIDTH - 1, body);
    if s.selected < s.scroll {
        s.scroll = s.selected;
    } else if s.selected >= s.scroll + body {
        s.scroll = s.selected + 1 - body;
    }

    // Header: the filter.
    let header = format!(
        " topowall preview  │  filter: {}▏  {} of {}",
        s.query,
        s.shown.len(),
        s.all.len()
    );
    queue!(
        out,
        SetAttribute(Attribute::Bold),
        Print(fit(&header, w)),
        SetAttribute(Attribute::Reset),
        Print("\r\n")
    )?;

    // The map for the selected scheme.
    let pixels = match s.choice() {
        Some(choice) => Some(draw(&choice, cols, rows)?),
        None => None,
    };
    let map = pixels.map(|px| terminal::half_blocks(&px, cols, rows * 2));
    let mut map_lines = map.as_deref().map(|m| m.lines()).into_iter().flatten();

    for row in 0..body {
        let i = s.scroll + row;
        match s.shown.get(i) {
            Some(&idx) => {
                let name = &s.all[idx].name;
                if i == s.selected {
                    queue!(
                        out,
                        SetAttribute(Attribute::Reverse),
                        Print(fit(&format!(" › {name}"), LIST_WIDTH)),
                        SetAttribute(Attribute::Reset)
                    )?;
                } else {
                    queue!(out, Print(fit(&format!("   {name}"), LIST_WIDTH)))?;
                }
            }
            None if i == 0 && s.shown.is_empty() => {
                queue!(out, Print(fit("   no matches", LIST_WIDTH)))?
            }
            None => queue!(out, Print(fit("", LIST_WIDTH)))?,
        }
        queue!(out, Print(" "))?;
        match map_lines.next() {
            Some(line) => queue!(out, Print(line), Print("\x1b[0m"))?,
            None => queue!(out, Print(fit("", cols)))?,
        }
        queue!(out, Print("\r\n"))?;
    }

    // The selected scheme: title, tags and colors.
    let info = match s.entry() {
        Some(e) => {
            let strip = palette::builtin_base16(&e.name)
                .map(|(base, _)| terminal::swatches(&base))
                .unwrap_or_default();
            let text = format!(
                " {} · {} · {}{}  ",
                e.title,
                e.tags.join(" "),
                s.style.name(),
                if s.black { ", black background" } else { "" }
            );
            let room = w.saturating_sub(34);
            format!("{}{}\x1b[0m", fit(&text, room), strip)
        }
        None => fit(" nothing matches the filter", w),
    };
    queue!(
        out,
        Print(info),
        term::Clear(ClearType::UntilNewLine),
        Print("\r\n")
    )?;
    let help = " type to filter  ↑↓ PgUp PgDn choose  Tab style  Shift+Tab background  Enter pick  Esc quit";
    queue!(
        out,
        SetAttribute(Attribute::Dim),
        Print(fit(help, w)),
        SetAttribute(Attribute::Reset)
    )?;
    out.flush()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn state() -> State<'static> {
        let all = topowall_render::tags::catalog();
        State {
            all,
            query: String::new(),
            shown: (0..all.len()).collect(),
            selected: 0,
            scroll: 0,
            style: Style::Subtle,
            black: false,
        }
    }

    fn key(code: KeyCode) -> KeyEvent {
        KeyEvent::new(code, KeyModifiers::NONE)
    }

    #[test]
    fn typing_filters_by_name_and_tags() {
        let mut s = state();
        for c in "rosepine".chars() {
            handle(&mut s, key(KeyCode::Char(c)));
        }
        assert!(s.shown.len() >= 3);
        assert!(s
            .shown
            .iter()
            .all(|&i| s.all[i].name.starts_with("rose-pine")));
        // Words can also be tags: every result mentions each word somewhere.
        s.query = "light warm".into();
        s.filter();
        assert!(!s.shown.is_empty());
        for &i in &s.shown {
            let e = &s.all[i];
            let text = format!("{} {} {}", e.name, e.title.to_lowercase(), e.tags.join(" "));
            assert!(
                text.contains("light") && text.contains("warm"),
                "{}",
                e.name
            );
        }
    }

    #[test]
    fn keys_move_cycle_style_and_pick() {
        let mut s = state();
        handle(&mut s, key(KeyCode::Down));
        handle(&mut s, key(KeyCode::Down));
        assert_eq!(s.selected, 2);
        handle(&mut s, key(KeyCode::Up));
        assert_eq!(s.selected, 1);
        handle(&mut s, key(KeyCode::Tab));
        assert_eq!(s.style, Style::Vivid);
        handle(&mut s, key(KeyCode::BackTab));
        assert!(s.black);
        let choice = s.choice().unwrap();
        assert_eq!(choice.palette, s.all[1].name);
        assert!(matches!(handle(&mut s, key(KeyCode::Enter)), Action::Pick));
        s.query = "x".into();
        assert!(matches!(handle(&mut s, key(KeyCode::Esc)), Action::Redraw));
        assert!(matches!(handle(&mut s, key(KeyCode::Esc)), Action::Quit));
    }
}
