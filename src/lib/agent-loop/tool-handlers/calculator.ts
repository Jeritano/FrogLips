/**
 * Safe arithmetic evaluator for the `calculate` tool. A hand-written
 * shunting-yard parser — NEVER `eval()`/`Function()` — so a model can't smuggle
 * code execution through an "expression". Supports + - * / % ^, unary minus,
 * parentheses, and a small set of named functions/constants. Returns a result
 * object the tool serializes directly.
 */
export function safeCalculate(
  expr: string,
):
  | { ok: true; expression: string; result: number }
  | { ok: false; error: string } {
  const src = expr.trim();
  if (!src) return { ok: false, error: "empty expression" };
  if (src.length > 1024) return { ok: false, error: "expression too long" };

  const FUNCS: Record<string, (x: number) => number> = {
    sqrt: Math.sqrt,
    abs: Math.abs,
    sin: Math.sin,
    cos: Math.cos,
    tan: Math.tan,
    asin: Math.asin,
    acos: Math.acos,
    atan: Math.atan,
    ln: Math.log,
    log: Math.log10,
    log2: Math.log2,
    exp: Math.exp,
    floor: Math.floor,
    ceil: Math.ceil,
    round: Math.round,
    sign: Math.sign,
  };
  const CONSTS: Record<string, number> = {
    pi: Math.PI,
    e: Math.E,
    tau: Math.PI * 2,
  };

  // Tokenize.
  type Tok =
    | { t: "num"; v: number }
    | { t: "op"; v: string }
    | { t: "lp" }
    | { t: "rp" }
    | { t: "fn"; v: string };
  const toks: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === " " || c === "\t") {
      i++;
      continue;
    }
    if ((c >= "0" && c <= "9") || c === ".") {
      let j = i + 1;
      while (j < src.length && /[0-9.eE+\-]/.test(src[j])) {
        // Allow exponent sign only right after e/E.
        if ((src[j] === "+" || src[j] === "-") && !/[eE]/.test(src[j - 1]))
          break;
        j++;
      }
      const num = Number(src.slice(i, j));
      if (!Number.isFinite(num))
        return { ok: false, error: `bad number near "${src.slice(i, j)}"` };
      toks.push({ t: "num", v: num });
      i = j;
      continue;
    }
    if (/[a-zA-Z_]/.test(c)) {
      let j = i + 1;
      while (j < src.length && /[a-zA-Z0-9_]/.test(src[j])) j++;
      const name = src.slice(i, j).toLowerCase();
      if (name in CONSTS) toks.push({ t: "num", v: CONSTS[name] });
      else if (name in FUNCS) toks.push({ t: "fn", v: name });
      else return { ok: false, error: `unknown name "${name}"` };
      i = j;
      continue;
    }
    if ("+-*/%^".includes(c)) {
      toks.push({ t: "op", v: c });
      i++;
      continue;
    }
    if (c === "(") {
      toks.push({ t: "lp" });
      i++;
      continue;
    }
    if (c === ")") {
      toks.push({ t: "rp" });
      i++;
      continue;
    }
    return { ok: false, error: `unexpected character "${c}"` };
  }

  // Shunting-yard → RPN, tracking unary minus.
  const out: Tok[] = [];
  const ops: Tok[] = [];
  const prec: Record<string, number> = {
    "+": 1,
    "-": 1,
    "*": 2,
    "/": 2,
    "%": 2,
    "u-": 3,
    "^": 4,
  };
  const rightAssoc = (o: string) => o === "^" || o === "u-";
  let prev: Tok | null = null;
  for (const tk of toks) {
    if (tk.t === "num") out.push(tk);
    else if (tk.t === "fn") ops.push(tk);
    else if (tk.t === "op") {
      // Unary minus: a "-" at the start or after another op / "(".
      const unary =
        tk.v === "-" && (prev === null || prev.t === "op" || prev.t === "lp");
      const o: Tok = unary ? { t: "op", v: "u-" } : tk;
      while (
        ops.length &&
        ops[ops.length - 1].t === "op" &&
        (prec[(ops[ops.length - 1] as { v: string }).v] > prec[o.v] ||
          (prec[(ops[ops.length - 1] as { v: string }).v] === prec[o.v] &&
            !rightAssoc(o.v)))
      ) {
        out.push(ops.pop() as Tok);
      }
      ops.push(o);
    } else if (tk.t === "lp") ops.push(tk);
    else if (tk.t === "rp") {
      while (ops.length && ops[ops.length - 1].t !== "lp")
        out.push(ops.pop() as Tok);
      if (!ops.length) return { ok: false, error: "mismatched parentheses" };
      ops.pop(); // discard lp
      if (ops.length && ops[ops.length - 1].t === "fn")
        out.push(ops.pop() as Tok);
    }
    prev = tk;
  }
  while (ops.length) {
    const o = ops.pop() as Tok;
    if (o.t === "lp") return { ok: false, error: "mismatched parentheses" };
    out.push(o);
  }

  // Evaluate RPN.
  const st: number[] = [];
  for (const tk of out) {
    if (tk.t === "num") st.push(tk.v);
    else if (tk.t === "fn") {
      const a = st.pop();
      if (a === undefined) return { ok: false, error: "malformed expression" };
      st.push(FUNCS[tk.v](a));
    } else if (tk.t === "op") {
      if (tk.v === "u-") {
        const a = st.pop();
        if (a === undefined)
          return { ok: false, error: "malformed expression" };
        st.push(-a);
        continue;
      }
      const b = st.pop();
      const a = st.pop();
      if (a === undefined || b === undefined)
        return { ok: false, error: "malformed expression" };
      switch (tk.v) {
        case "+":
          st.push(a + b);
          break;
        case "-":
          st.push(a - b);
          break;
        case "*":
          st.push(a * b);
          break;
        case "/":
          st.push(a / b);
          break;
        case "%":
          st.push(a % b);
          break;
        case "^":
          st.push(Math.pow(a, b));
          break;
        default:
          return { ok: false, error: `bad operator "${tk.v}"` };
      }
    }
  }
  if (st.length !== 1 || !Number.isFinite(st[0])) {
    return { ok: false, error: "could not evaluate expression" };
  }
  return { ok: true, expression: src, result: st[0] };
}
