/** A `go.mod` or `Cargo.toml`, read by the scan so a language module can name its packages. */
export type Manifest = { readonly path: string; readonly text: string };

/** The directory of a root-relative `/` path: `""` for a file at the root. */
export function dirOf(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? "" : path.slice(0, slash);
}

/** The last name of a root-relative `/` path. */
export function nameOf(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

export function joinPath(directory: string, ...names: readonly string[]): string {
  return [directory, ...names].filter((name) => name !== "").join("/");
}

/**
 * Only the pieces of a source file that an import can be made of. A comment never becomes a token, and
 * a string is one token however it is written, so the code that reads imports cannot be fooled by
 * either. `other` is a number, a character or a lifetime: it keeps the neighbours of a declaration
 * from looking adjacent.
 */
export type Token = {
  readonly kind: "ident" | "string" | "punct" | "other";
  readonly text: string;
};

/** What differs between the languages in how their source is cut into tokens. */
export type Syntax = {
  /** A block comment may hold block comments, and ends with its outermost close (Kotlin, Rust). */
  readonly nestedComments: boolean;
  /** Go starts a raw string with a backtick, Kotlin a quoted identifier. */
  readonly backtick: "raw-string" | "identifier" | "punct";
  /** Rust: raw strings, lifetimes against character literals, and `::` as one token. */
  readonly rust: boolean;
};

const SLASH = 0x2f;
const STAR = 0x2a;
const QUOTE = 0x22;
const APOSTROPHE = 0x27;
const BACKSLASH = 0x5c;
const HASH = 0x23;
const BACKTICK = 0x60;
const COLON = 0x3a;

function isIdentStart(code: number, dollar: boolean): boolean {
  return (
    (code >= 97 && code <= 122) ||
    (code >= 65 && code <= 90) ||
    code === 95 ||
    code >= 128 ||
    (dollar && code === 36)
  );
}

function isIdentPart(code: number, dollar: boolean): boolean {
  return isIdentStart(code, dollar) || (code >= 48 && code <= 57);
}

function skipBlockComment(text: string, from: number, nested: boolean): number {
  if (!nested) {
    const end = text.indexOf("*/", from);
    return end === -1 ? text.length : end + 2;
  }
  let depth = 1;
  let at = from;
  while (at < text.length) {
    const code = text.charCodeAt(at);
    const next = text.charCodeAt(at + 1);
    if (code === SLASH && next === STAR) {
      depth += 1;
      at += 2;
    } else if (code === STAR && next === SLASH) {
      depth -= 1;
      at += 2;
      if (depth === 0) return at;
    } else {
      at += 1;
    }
  }
  return text.length;
}

/** The first index at or after `from` that is not white space or a comment; `text.length` at the end. */
function skipTrivia(text: string, from: number, nested: boolean): number {
  let at = from;
  while (at < text.length) {
    const code = text.charCodeAt(at);
    const next = text.charCodeAt(at + 1);
    if (code === SLASH && next === SLASH) {
      const end = text.indexOf("\n", at + 2);
      if (end === -1) return text.length;
      at = end + 1;
    } else if (code === SLASH && next === STAR) {
      at = skipBlockComment(text, at + 2, nested);
    } else if (code <= 32 || code === 0xa0 || code === 0xfeff) {
      at += 1;
    } else {
      return at;
    }
  }
  return text.length;
}

/** The index of the quote that closes the string opened at `open`, or -1 when it never closes. */
function closingQuote(text: string, open: number, quote: number): number {
  let at = open + 1;
  while (at < text.length) {
    const code = text.charCodeAt(at);
    if (code === BACKSLASH) at += 2;
    else if (code === quote) return at;
    else at += 1;
  }
  return -1;
}

/** At `from`, the `#`s and quote that open a raw string; the index past its end, or -1 if it is no raw string. */
function skipRawString(text: string, from: number): number {
  let hashes = 0;
  while (text.charCodeAt(from + hashes) === HASH) hashes += 1;
  if (text.charCodeAt(from + hashes) !== QUOTE) return -1;
  const close = `"${"#".repeat(hashes)}`;
  const end = text.indexOf(close, from + hashes + 1);
  return end === -1 ? text.length : end + close.length;
}

const OTHER: Token = { kind: "other", text: "" };
const EMPTY_STRING: Token = { kind: "string", text: "" };
const DOUBLE_COLON: Token = { kind: "punct", text: "::" };
/** One shared token for each ASCII punctuation character, so the lexer allocates none for them. */
const PUNCT: readonly Token[] = Array.from({ length: 128 }, (_, code) => ({
  kind: "punct",
  text: String.fromCharCode(code),
}));

/** The next token each time it is called, and `null` at the end. Anything it cannot place is a `punct`. */
export type Lexer = () => Token | null;

export function lexer(text: string, syntax: Syntax): Lexer {
  const { rust, nestedComments } = syntax;
  const dollar = !rust;
  let at = 0;
  return () => {
    at = skipTrivia(text, at, nestedComments);
    if (at >= text.length) return null;
    const code = text.charCodeAt(at);

    if (isIdentStart(code, dollar)) {
      let end = at + 1;
      while (end < text.length && isIdentPart(text.charCodeAt(end), dollar)) end += 1;
      const word = text.slice(at, end);
      if (rust && (word === "r" || word === "br" || word === "cr")) {
        const after = text.charCodeAt(end);
        if (after === HASH || after === QUOTE) {
          const past = skipRawString(text, end);
          if (past !== -1) {
            at = past;
            return EMPTY_STRING;
          }
          if (word === "r" && isIdentStart(text.charCodeAt(end + 1), false)) {
            let raw = end + 2;
            while (raw < text.length && isIdentPart(text.charCodeAt(raw), false)) raw += 1;
            const name = text.slice(end + 1, raw);
            at = raw;
            return { kind: "ident", text: name };
          }
        }
      }
      at = end;
      return { kind: "ident", text: word };
    }
    if (code >= 48 && code <= 57) {
      let end = at + 1;
      while (end < text.length && isIdentPart(text.charCodeAt(end), dollar)) end += 1;
      at = end;
      return OTHER;
    }
    if (code === QUOTE) {
      const close = closingQuote(text, at, QUOTE);
      if (close === -1) {
        at = text.length;
        return OTHER;
      }
      const value = text.slice(at + 1, close);
      at = close + 1;
      return { kind: "string", text: value };
    }
    if (code === BACKTICK && syntax.backtick !== "punct") {
      const close = text.indexOf("`", at + 1);
      if (close === -1) {
        at = text.length;
        return OTHER;
      }
      const value = text.slice(at + 1, close);
      at = close + 1;
      return { kind: syntax.backtick === "raw-string" ? "string" : "ident", text: value };
    }
    if (code === APOSTROPHE && rust) {
      at = skipApostrophe(text, at);
      return OTHER;
    }
    if (rust && code === COLON && text.charCodeAt(at + 1) === COLON) {
      at += 2;
      return DOUBLE_COLON;
    }
    at += 1;
    return PUNCT[code] ?? OTHER;
  };
}

/** The whole file as tokens. */
export function lexAll(text: string, syntax: Syntax): Token[] {
  const next = lexer(text, syntax);
  const tokens: Token[] = [];
  for (let token = next(); token !== null; token = next()) tokens.push(token);
  return tokens;
}

/** Rust: past the character literal or lifetime that starts at `at`. A lone `'` counts as one character. */
function skipApostrophe(text: string, at: number): number {
  const next = text.charCodeAt(at + 1);
  if (next === BACKSLASH) {
    const close = closingQuote(text, at, APOSTROPHE);
    return close === -1 ? text.length : close + 1;
  }
  const width = (text.codePointAt(at + 1) ?? 0) > 0xffff ? 2 : 1;
  if (text.charCodeAt(at + 1 + width) === APOSTROPHE) return at + width + 2;
  let end = at + 1;
  while (end < text.length && isIdentPart(text.charCodeAt(end), false)) end += 1;
  return end;
}

/** One token of lookahead over a `Lexer`, for the readers that stop after the head of a file. */
export type Cursor = {
  readonly peek: () => Token | null;
  readonly next: () => Token | null;
};

export function cursor(lexed: Lexer): Cursor {
  let ahead: Token | null | undefined;
  const peek = (): Token | null => {
    if (ahead === undefined) ahead = lexed();
    return ahead;
  };
  return {
    peek,
    next() {
      const token = peek();
      ahead = undefined;
      return token;
    },
  };
}

export function isWord(token: Token | null, word: string): boolean {
  return token?.kind === "ident" && token.text === word;
}

export function isPunct(token: Token | null, text: string): boolean {
  return token?.kind === "punct" && token.text === text;
}
