// The web's prompt editor is CodeMirror with `markdown({ base: markdownLanguage, codeLanguages:
// languages })`, basicSetup and the @uiw/react-markdown-editor theme. Running the same grammars
// and commands is the only way the iOS composer colors and edits text identically.
import { EditorState } from '@codemirror/state';
import {
  deleteMarkupBackward,
  insertNewlineContinueMarkup,
  markdown,
  markdownLanguage,
} from '@codemirror/lang-markdown';
import { languages } from '@codemirror/language-data';
import {
  LanguageDescription,
  ensureSyntaxTree,
  indentOnInput,
  matchBrackets,
  syntaxTree,
} from '@codemirror/language';
import {
  CompletionContext,
  closeBrackets,
  completeFromList,
  deleteBracketPair,
  insertBracket,
  insertCompletionText,
  pickedCompletion,
} from '@codemirror/autocomplete';
import { deleteCharBackward, insertNewlineAndIndent } from '@codemirror/commands';
import { highlightTree, tagHighlighter, tags as t } from '@lezer/highlight';
import { FuzzyMatcher } from './fuzzy.js';

// Order matters: Swift's `ComposerEngine.TokenColor` has the same cases at the same indexes.
const colors = [
  'comment', 'variable', 'entity', 'keyword', 'string', 'accent', 'red', 'list',
  'heading', 'regexp', 'literal', 'link', 'fg', 'tag', 'constant',
];
const color = name => colors.indexOf(name);

// @uiw/react-markdown-editor/esm/theme.js, in its order: a later rule wins for the same tag, and
// for a span with several classes, as generated CSS rules do.
const rules = [
  { tag: t.comment, color: color('comment') },
  { tag: t.variableName, color: color('variable') },
  { tag: [t.string, t.special(t.brace)], color: color('entity') },
  { tag: t.number, color: color('variable') },
  { tag: [t.bool, t.null], color: color('entity') },
  { tag: t.keyword, color: color('keyword'), bold: true },
  { tag: t.string, color: color('string') },
  { tag: t.operator, color: color('accent') },
  { tag: t.deleted, color: color('red') },
  { tag: t.className, color: color('variable') },
  { tag: t.definition(t.typeName), color: color('entity') },
  { tag: t.typeName, color: color('entity') },
  { tag: t.list, color: color('list') },
  { tag: t.heading, color: color('heading'), bold: true },
  { tag: t.regexp, color: color('regexp') },
  { tag: t.literal, color: color('literal') },
  { tag: t.link, color: color('link'), underline: true },
  { tag: t.angleBracket, color: color('fg') },
  { tag: t.tagName, color: color('tag') },
  { tag: t.attributeName, color: color('constant') },
];

const highlighter = tagHighlighter(rules.map((rule, index) => ({ tag: rule.tag, class: String(index) })));

const extensions = [
  // Keeps every offset equal to the text view's, whatever line endings were pasted in.
  EditorState.lineSeparator.of('\n'),
  markdown({ base: markdownLanguage, codeLanguages: languages }),
  closeBrackets(),
  indentOnInput(),
];

const editors = new Map();
const openCompletions = new Map();

function stateFor(id, text, anchor, head) {
  let state = editors.get(id);
  if (!state || state.doc.toString() !== text) state = EditorState.create({ doc: text, extensions });
  if (anchor != null && (state.selection.main.anchor !== anchor || state.selection.main.head !== head)) {
    state = state.update({ selection: { anchor, head } }).state;
  }
  editors.set(id, state);
  return state;
}

// Commands read `syntaxTree(state)`, which only sees a finished parse after a transaction.
function parsed(state) {
  const tree = ensureSyntaxTree(state, state.doc.length, 5000);
  return tree && tree !== syntaxTree(state) ? state.update({}).state : state;
}

function unloadedLanguages(state) {
  const pending = [];
  syntaxTree(state).iterate({
    enter(node) {
      if (node.name !== 'CodeInfo') return;
      const info = /\S*/.exec(state.sliceDoc(node.from, node.to))[0];
      const found = LanguageDescription.matchLanguageName(languages, info, true);
      if (found && !found.support) pending.push(found.load());
    },
  });
  return pending;
}

function runs(state) {
  const tree = ensureSyntaxTree(state, state.doc.length, 5000) || syntaxTree(state);
  const out = [];
  highlightTree(tree, highlighter, (from, to, classes) => {
    let tokenColor = -1;
    let bold = 0;
    let underline = 0;
    for (const index of classes.split(' ').map(Number).sort((a, b) => a - b)) {
      const rule = rules[index];
      tokenColor = rule.color;
      if (rule.bold) bold = 1;
      if (rule.underline) underline = 1;
    }
    out.push(from, to, tokenColor, bold, underline);
  });
  return out;
}

function report(tr) {
  const changes = [];
  tr.changes.iterChanges((fromA, toA, fromB, toB, inserted) => {
    changes.push({ from: fromA, to: toA, insert: inserted.toString() });
  });
  const { anchor, head } = tr.state.selection.main;
  return { changes, anchor, head };
}

function firstCommand(state, commands) {
  for (const command of commands) {
    let captured = null;
    if (command({ state, dispatch: tr => { captured = tr; } })) return captured;
  }
  return null;
}

function isPlainEdit(tr, from, to, insert) {
  const changes = [];
  tr.changes.iterChanges((fromA, toA, fromB, toB, inserted) => {
    changes.push([fromA, toA, inserted.toString()]);
  });
  return (changes.length === 0 && from === to && insert === '')
    || (changes.length === 1 && changes[0][0] === from && changes[0][1] === to && changes[0][2] === insert
      && tr.state.selection.main.empty && tr.state.selection.main.head === from + insert.length);
}

const nonPlainText = /code|horizontalrule|html|link|comment|processing|escape|entity|image|mark|url/i;

function pickOptions(active, state) {
  const options = [];
  for (const { result } of active) {
    const to = result.to == null ? state.selection.main.from : result.to;
    const pattern = state.sliceDoc(result.from, to);
    if (result.filter === false) {
      for (const completion of result.options) {
        options.push({
          completion, result, matched: result.getMatch ? result.getMatch(completion) : [], score: 1e9 - options.length,
        });
      }
    } else {
      const matcher = new FuzzyMatcher(pattern);
      for (const completion of result.options) {
        const match = matcher.match(completion.label);
        if (!match) continue;
        const matched = !completion.displayLabel
          ? match.matched
          : result.getMatch ? result.getMatch(completion, match.matched) : [];
        options.push({ completion, result, matched, score: match.score + (completion.boost || 0) });
      }
    }
  }
  const compare = (a, b) => (a.sortText || a.label).localeCompare(b.sortText || b.label);
  const rank = option => (option.boost || 0) * 100 + (option.apply ? 10 : 0) + (option.info ? 5 : 0) + (option.type ? 1 : 0);
  const sorted = options.sort((a, b) => (b.score - a.score) || compare(a.completion, b.completion));
  const unique = [];
  let previous = null;
  for (const option of sorted) {
    const current = option.completion;
    if (!previous || previous.label !== current.label || previous.detail !== current.detail
      || (previous.type != null && current.type != null && previous.type !== current.type)
      || previous.apply !== current.apply || previous.boost !== current.boost) {
      unique.push(option);
    } else if (rank(option.completion) > rank(previous)) {
      unique[unique.length - 1] = option;
    }
    previous = option.completion;
  }
  return unique.slice(0, 100);
}

globalThis.ComposerEngine = {
  // Colored runs, flattened as from, to, color, bold, underline. A fenced language loads on first
  // use, so the callback can come after a reparse that picks it up.
  highlight(id, text, callback) {
    const state = stateFor(id, text);
    const parsedState = parsed(state);
    editors.set(id, parsedState);
    const pending = unloadedLanguages(parsedState);
    if (!pending.length) {
      callback(JSON.stringify(runs(parsedState)));
      return;
    }
    Promise.allSettled(pending).then(() => {
      const current = editors.get(id);
      if (!current || current.doc.toString() !== text) return;
      const fresh = parsed(EditorState.create({ doc: text, selection: current.selection, extensions }));
      editors.set(id, fresh);
      callback(JSON.stringify(runs(fresh)));
    });
  },

  // One keyboard edit from `from` to `to`, with the selection it was made from. Returns the
  // changes to apply when the editor does something other than the plain edit, otherwise null.
  input(id, text, anchor, head, from, to, insert) {
    openCompletions.delete(id);
    const state = parsed(stateFor(id, text, anchor, head));
    const caret = anchor === head;
    let tr = null;
    if (insert === '\n') {
      tr = firstCommand(state, [insertNewlineContinueMarkup, insertNewlineAndIndent]);
    } else if (insert === '' && caret && to === anchor && to > from) {
      tr = firstCommand(state, [deleteMarkupBackward, deleteBracketPair, deleteCharBackward]);
    } else if (insert.length === 1 || (insert.length === 2 && insert.codePointAt(0) > 0xffff)) {
      tr = insertBracket(state, insert);
    }
    if (!tr) {
      const event = insert === '' ? 'delete' : 'input.type';
      tr = state.update({ changes: { from, to, insert }, selection: { anchor: from + insert.length }, userEvent: event });
    }
    editors.set(id, tr.state);
    return isPlainEdit(tr, from, to, insert) ? null : JSON.stringify(report(tr));
  },

  // Decorations for the caret or selection: `.cm-matchingBracket` and `.cm-nonmatchingBracket`.
  brackets(id, text, anchor, head) {
    if (anchor !== head) return '[]';
    const state = parsed(stateFor(id, text, anchor, head));
    editors.set(id, state);
    const match = matchBrackets(state, head, -1)
      || (head > 0 && matchBrackets(state, head - 1, 1))
      || matchBrackets(state, head, 1)
      || (head < state.doc.length && matchBrackets(state, head + 1, -1));
    if (!match) return '[]';
    const out = [{ from: match.start.from, to: match.start.to, matched: match.matched }];
    if (match.end) out.push({ from: match.end.from, to: match.end.to, matched: match.matched });
    return JSON.stringify(out);
  },

  // `pasteURLAsLink`: pasting a URL over plain selected text makes it a link.
  pasteLink(id, text, anchor, head, pasted) {
    let link = pasted;
    if (anchor === head || !link || !/^(https?:\/\/|mailto:|xmpp:|www\.)/.test(link)) return null;
    if (/^www\./.test(link)) link = `https://${link}`;
    const state = parsed(stateFor(id, text, anchor, head));
    const { main } = state.selection;
    if (!markdownLanguage.isActiveAt(state, main.from, 1)) return null;
    let crossesNode = false;
    syntaxTree(state).iterate({
      from: main.from,
      to: main.to,
      enter: node => { if (node.from > main.from || nonPlainText.test(node.name)) crossesNode = true; },
      leave: node => { if (node.to < main.to) crossesNode = true; },
    });
    if (crossesNode) return null;
    const tr = state.update({
      changes: [{ from: main.from, insert: '[' }, { from: main.to, insert: `](${link})` }],
      userEvent: 'input.paste',
    });
    editors.set(id, tr.state);
    return JSON.stringify(report(tr));
  },

  // The completion popup for a caret: what `autocompletion()` shows after typing stops.
  completions(id, text, pos, callback) {
    const state = parsed(stateFor(id, text, pos, pos));
    editors.set(id, state);
    const context = new CompletionContext(state, pos, false);
    const sources = state.languageDataAt('autocomplete', pos)
      .map(source => (Array.isArray(source) ? completeFromList(source) : source));
    Promise.all(sources.map(source => Promise.resolve().then(() => source(context)).catch(() => null))).then(results => {
      const current = editors.get(id);
      if (!current || current.doc.toString() !== text) return;
      const active = results.filter(Boolean).map(result => ({ result }));
      const options = pickOptions(active, state);
      openCompletions.set(id, options);
      callback(JSON.stringify({
        from: active.reduce((from, { result }) => Math.min(from, result.from), pos),
        options: options.map(option => ({
          label: option.completion.displayLabel || option.completion.label,
          type: option.completion.type || '',
          detail: option.completion.detail || '',
          matched: Array.from(option.matched || []),
        })),
      }));
    });
  },

  applyCompletion(id, text, anchor, head, index) {
    const options = openCompletions.get(id);
    openCompletions.delete(id);
    const option = options && options[index];
    if (!option) return null;
    const state = stateFor(id, text, anchor, head);
    const { completion, result } = option;
    const to = result.to == null ? head : result.to;
    const apply = completion.apply || completion.label;
    let captured = null;
    if (typeof apply === 'string') {
      captured = state.update({
        ...insertCompletionText(state, apply, result.from, to),
        annotations: pickedCompletion.of(completion),
      });
    } else {
      apply({ state, dispatch: tr => { captured = tr; } }, completion, result.from, to);
    }
    if (!captured) return null;
    editors.set(id, captured.state);
    return JSON.stringify(report(captured));
  },

  close(id) {
    editors.delete(id);
    openCompletions.delete(id);
  },
};
