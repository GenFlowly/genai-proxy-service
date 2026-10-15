// Fixed Typst template for graph_tools/tools/pdf_typst.py (plan 5.1, 6.1, 6.2).
//
// Every piece of document content arrives as JSON *data* in sys.inputs:
//   sys.inputs.tree  the render tree built by pdf_typst.py from the
//                    pdf_markdown token tree (node kinds listed in render());
//   sys.inputs.meta  page, language, fonts, footer and branding settings.
// User text is only ever inserted as string values, never parsed as Typst
// markup or code, so '#set', '#read(...)', '$x$', '<label>' or '@ref' in a
// document print literally. The one evaluation path is mitex, which only gets
// TeX that pdf_typst.py has filtered and checked in a separate compile.
#import "@preview/mitex:0.2.7": mitex, mi

#let meta = json(bytes(sys.inputs.meta))
#let tree = json(bytes(sys.inputs.tree))

#let ink = rgb("#1a1a1a")
#let accent = if meta.accent != none { rgb(meta.accent) } else { rgb("#111111") }
#let rule-paint = if meta.accent != none { rgb(meta.accent) } else { luma(204) }
#let dir-value(d) = if d == "rtl" { rtl } else { ltr }

#let footer = context {
  let current = counter(page).get().first()
  let total = counter(page).final().first()
  let line = meta.footer.map(p => if p == "{page}" { str(current) } else if p == "{total}" { str(total) } else { p }).join()
  set text(size: 8pt, fill: luma(140), dir: dir-value(meta.footer_dir))
  if meta.footer_text != none {
    align(center, stack(dir: ttb, spacing: 4pt, text(meta.footer_text), text(line)))
  } else {
    align(center, text(line))
  }
}

#set document(title: meta.title)
#set page(
  paper: meta.paper,
  flipped: meta.flipped,
  margin: (x: 1.8cm, top: 2cm, bottom: 2.2cm),
  footer: footer,
  footer-descent: 35%,
)
#set text(font: meta.fonts, size: 10.5pt, fill: ink, lang: meta.lang, dir: dir-value(meta.dir))
#set text(region: meta.region) if meta.region != none
#set par(leading: 0.62em, spacing: 0.95em)
#set list(indent: 0.4em, body-indent: 0.55em)
#set enum(indent: 0.4em, body-indent: 0.55em)
// Typst sets raw text at 0.8em of its surroundings; 1.125em makes inline code
// 0.9 of the surrounding size. Code blocks are a fixed 9pt.
#show raw: set text(font: meta.mono)
#show raw.where(block: false): set text(size: 1.125em)
#show raw.where(block: true): set text(size: 9pt)
#show raw.where(block: true): it => block(fill: luma(245), inset: 6pt, radius: 2pt, width: 100%, it)
#show heading: set text(fill: accent)
#show heading: set block(above: 1.25em, below: 0.65em)
#show heading.where(level: 1): set text(size: 20pt)
#show heading.where(level: 2): set text(size: 15pt)
#show heading.where(level: 3): set text(size: 12pt)
#show heading.where(level: 4): set text(size: 11pt)
#show link: set text(fill: rgb("#0b57d0"))
#show math.equation: set text(font: meta.math_fonts)

// Letterhead (6.2) and title heading, at the top of page 1.
#let preamble = {
  if meta.logo != none or meta.company != none {
    block(below: 1.1em, {
      grid(
        columns: (auto, 1fr),
        column-gutter: 12pt,
        align: (start + horizon, end + horizon),
        if meta.logo != none { image(meta.logo, height: 1.3cm, alt: meta.logo_alt) } else { [] },
        if meta.company != none { text(size: 13pt, weight: "bold", fill: accent, meta.company) } else { [] },
      )
      v(4pt)
      line(length: 100%, stroke: 0.8pt + rule-paint)
    })
  }
  if meta.title_heading != none { heading(level: 1, meta.title_heading) }
}

// render(n): one recursive walker for every node kind (Typst closures cannot
// refer to functions defined after them, so there is a single dispatcher).
//   string          text
//   array           a sequence of nodes
//   inline  {t: b|i|s|u|sub|sup (c), br, code (v: str | chunk array),
//            math (ok, v), link (href, c), ref (to, c), chunks (v),
//            emoji (v), task (v), img (src, alt, full, w), fn (first, label, c)}
//   block   {t: p (c, dir), ip (paragraph inside an item: inline content),
//            li (c: blocks joined by paragraph breaks), h (level, id, c, dir),
//            ul|ol (items, tight, tasks, start, numbering, dir), table,
//            codeblock (v, lang), pre (lines), mathblock (ok, v, eqno),
//            quote (c, dir), hr, dl (items: term, defs)}
#let render(n) = {
  if type(n) == str { return n }
  if type(n) == array { return { for x in n { render(x) } } }
  let t = n.t
  let d = n.at("dir", default: none)
  let body = if t == "b" { strong(render(n.c)) }
  else if t == "i" { emph(render(n.c)) }
  else if t == "s" { strike(render(n.c)) }
  else if t == "u" { underline(render(n.c)) }
  else if t == "sub" { sub(render(n.c)) }
  else if t == "sup" { super(render(n.c)) }
  else if t == "br" { linebreak() }
  else if t == "code" {
    if type(n.v) == str { raw(n.v) } else { for c in n.v { box(raw(c)) } }
  }
  else if t == "math" { if n.ok { mi(n.v) } else { raw(n.v) } }
  else if t == "mathblock" {
    let eq = if n.ok { mitex(n.v) } else { raw(n.v, block: true) }
    if n.eqno != none { grid(columns: (1fr, auto), align: horizon, eq, [(#n.eqno)]) } else { eq }
  }
  else if t == "li" {
    // Item/footnote/definition body. Consecutive paragraphs need a paragraph
    // break; nested lists, tables and code are blocks and space themselves.
    for (i, b) in n.c.enumerate() {
      if i > 0 and b.t == "ip" and n.c.at(i - 1).t == "ip" { parbreak() }
      render(b)
    }
  }
  else if t == "link" { link(n.href, render(n.c)) }
  else if t == "ref" { link(label(n.to), render(n.c)) }
  else if t == "chunks" { for c in n.v { box(c) } }
  else if t == "emoji" { text(font: meta.emoji_fonts, n.v) }
  else if t == "task" {
    box(text(font: meta.symbol_fonts, if n.v { "\u{2611}" } else { "\u{2610}" }))
    h(0.35em)
  }
  else if t == "img" {
    // image() is block-level; a box keeps it inline in its paragraph.
    if n.full { box(width: 100%, image(n.src, alt: n.alt, width: 100%)) }
    else { box(image(n.src, alt: n.alt, width: n.w * 1pt)) }
  }
  else if t == "fn" {
    if n.first { [#footnote(render(n.c))#label(n.label)] } else { footnote(label(n.label)) }
  }
  else if t == "p" { par(render(n.c)) }
  else if t == "ip" { render(n.c) }
  else if t == "h" {
    let h = heading(level: n.level, render(n.c))
    if n.id != none { [#h#label(n.id)] } else { h }
  }
  else if t == "ul" {
    let items = n.items.map(render)
    if n.tasks { list(tight: n.tight, marker: [], ..items) } else { list(tight: n.tight, ..items) }
  }
  else if t == "ol" {
    enum(tight: n.tight, start: n.start, numbering: n.numbering, ..n.items.map(render))
  }
  else if t == "table" {
    let aligns = n.align.map(a => if a == "right" { right } else if a == "center" { center } else if a == "left" { left } else { start })
    // Per-cell work dominates large tables: no fill closure, and when every
    // body cell is a plain string ("plain") the strings go in unmapped.
    let tbl = {
      set text(size: n.size * 1pt)
      set par(leading: 0.45em, justify: false)
      table(
        columns: n.cols.map(w => w * 1pt),
        align: aligns,
        inset: (x: n.inset * 1pt, y: n.inset_y * 1pt),
        stroke: 0.5pt + luma(204),
        table.header(..n.head.map(c => table.cell(fill: luma(240), strong(if type(c) == str { c } else { render(c) })))),
        ..if n.plain { n.cells } else { n.cells.map(c => if type(c) == str { c } else { render(c) }) },
      )
    }
    if n.landscape {
      // A very wide table gets its own landscape page, with the heading or
      // lead-in line that introduced it.
      let lead = n.at("lead", default: ())
      let content = {
        if n.at("preamble", default: false) { preamble }
        render(lead)
        if d == none { tbl } else { text(dir: dir-value(d), tbl) }
      }
      return page(flipped: not meta.flipped, content)
    }
    tbl
  }
  else if t == "codeblock" { raw(n.v, block: true, lang: n.lang) }
  else if t == "pre" {
    // Monospace lines whose tokens without a break opportunity are split into
    // boxes, so nothing runs past the margin (raw() cannot be split).
    block(fill: luma(245), inset: 6pt, radius: 2pt, width: 100%, {
      set text(font: meta.mono, size: 10pt)  // inline raw at 0.9 of this: 9pt like code blocks
      set par(leading: 0.55em)
      for (i, line) in n.lines.enumerate() {
        if i > 0 { linebreak() }
        for part in line {
          if type(part) == str { raw(part) } else { for c in part { box(raw(c)) } }
        }
      }
    })
  }
  else if t == "quote" {
    let right-side = d == "rtl"
    block(
      inset: if right-side { (right: 10pt, y: 2pt) } else { (left: 10pt, y: 2pt) },
      stroke: if right-side { (right: 2pt + luma(204)) } else { (left: 2pt + luma(204)) },
      { set text(fill: luma(85)); render(n.c) },
    )
  }
  else if t == "hr" { block(above: 0.9em, below: 0.9em, line(length: 100%, stroke: 0.5pt + rule-paint)) }
  else if t == "dl" {
    for item in n.items {
      block(above: 0.8em, below: 0.35em, strong(render(item.term)))
      for def in item.defs { block(above: 0.35em, inset: (left: 1.6em), render(def)) }
    }
  }
  if d == none { body } else { text(dir: dir-value(d), body) }
}

// ---------------------------------------------------------------------------
// Document
// ---------------------------------------------------------------------------

// When the document opens with a landscape table, the preamble goes on that
// page (the "preamble" flag on the table) instead of stranding on its own.
#if not (tree.len() > 0 and type(tree.at(0)) == dictionary and tree.at(0).at("preamble", default: false)) {
  preamble
}
#render(tree)
