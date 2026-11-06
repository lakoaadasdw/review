"""把 Python 源码导出成 apiflow 需要的 JSON（只解析，不执行项目代码）。

用法：python -X utf8 ast_dump.py <root>
输出到 stdout：{ root, files: [ ... ] }
"""
import ast
import json
import os
import sys

SKIP_DIRS = {
    "__pycache__", ".venv", "venv", "env", ".git", "node_modules",
    "site-packages", "build", "dist", ".mypy_cache", ".pytest_cache", ".ruff_cache",
}

ROUTE_KINDS = {
    "get": ["GET"], "post": ["POST"], "put": ["PUT"], "delete": ["DELETE"],
    "patch": ["PATCH"], "head": ["HEAD"], "options": ["OPTIONS"],
}


def walk_py(root):
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = sorted(d for d in dirnames if d not in SKIP_DIRS and not d.startswith("."))
        for name in sorted(filenames):
            if name.endswith(".py"):
                yield os.path.join(dirpath, name)


def literal(node):
    try:
        return ast.literal_eval(node)
    except Exception:
        return None


def expr(node, limit=160):
    try:
        text = ast.unparse(node)
    except Exception:
        return None
    return text[:limit]


def call_info(node):
    func = node.func
    if isinstance(func, ast.Attribute):
        return {"kind": "attr", "base": expr(func.value, 80), "name": func.attr, "lineno": node.lineno}
    if isinstance(func, ast.Name):
        return {"kind": "name", "base": None, "name": func.id, "lineno": node.lineno}
    return {"kind": "other", "base": None, "name": expr(func, 80), "lineno": node.lineno}


def decorator_info(dec):
    if not isinstance(dec, ast.Call):
        name = expr(dec, 80)
        return {"base": None, "name": name, "args": [], "kw": {}, "lineno": dec.lineno}
    func = dec.func
    if isinstance(func, ast.Attribute):
        base, name = expr(func.value, 80), func.attr
    elif isinstance(func, ast.Name):
        base, name = None, func.id
    else:
        base, name = None, expr(func, 80)
    args = [literal(a) if literal(a) is not None else expr(a, 80) for a in dec.args]
    kw = {}
    for item in dec.keywords:
        if item.arg is None:
            continue
        value = literal(item.value)
        kw[item.arg] = value if value is not None else expr(item.value, 80)
    return {"base": base, "name": name, "args": args, "kw": kw, "lineno": dec.lineno}


def collect_calls(body):
    """收集函数体里的调用点，不进入嵌套函数/lambda 内部。"""
    out = []

    def visit(node):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.Lambda, ast.ClassDef)):
            return
        if isinstance(node, ast.Call):
            out.append(call_info(node))
        for child in ast.iter_child_nodes(node):
            visit(child)

    for stmt in body:
        visit(stmt)
    return out


def parse_imports(tree):
    out = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                out.append({
                    "kind": "import", "module": alias.name, "name": None,
                    "asname": alias.asname, "level": 0, "lineno": node.lineno,
                })
        elif isinstance(node, ast.ImportFrom):
            for alias in node.names:
                out.append({
                    "kind": "from", "module": node.module or "", "name": alias.name,
                    "asname": alias.asname, "level": node.level or 0, "lineno": node.lineno,
                })
    return out


def parse_routers(tree):
    """模块顶层的 `router = APIRouter(prefix="/x")` / `app = FastAPI()`。"""
    routers = []
    for node in tree.body:
        if not isinstance(node, (ast.Assign, ast.AnnAssign)):
            continue
        value = node.value
        if not isinstance(value, ast.Call):
            continue
        callee = value.func
        name = callee.attr if isinstance(callee, ast.Attribute) else getattr(callee, "id", None)
        targets = node.targets if isinstance(node, ast.Assign) else [node.target]
        for target in targets:
            if not isinstance(target, ast.Name):
                continue
            kw = {}
            for item in value.keywords:
                if item.arg:
                    lit = literal(item.value)
                    kw[item.arg] = lit if lit is not None else expr(item.value, 80)
            routers.append({"var": target.id, "kind": name, "kw": kw, "lineno": node.lineno})
    return routers


def parse_includes(tree):
    """`app.include_router(auth.router, prefix="/api")`。"""
    includes = []
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        func = node.func
        if not isinstance(func, ast.Attribute) or func.attr != "include_router":
            continue
        target = expr(node.args[0], 120) if node.args else None
        kw = {}
        for item in node.keywords:
            if item.arg:
                lit = literal(item.value)
                kw[item.arg] = lit if lit is not None else expr(item.value, 80)
        if target:
            includes.append({"target": target, "kw": kw, "lineno": node.lineno})
    return includes


def parse_class(node):
    methods = []
    for item in node.body:
        if isinstance(item, (ast.FunctionDef, ast.AsyncFunctionDef)):
            methods.append(function_info(item, cls=node.name))
    return {
        "name": node.name,
        "lineno": node.lineno,
        "end_lineno": getattr(node, "end_lineno", node.lineno),
        "bases": [expr(b, 80) for b in node.bases],
        "methods": methods,
    }


def function_info(node, cls=None):
    return {
        "name": node.name,
        "cls": cls,
        "qual": f"{cls}.{node.name}" if cls else node.name,
        "lineno": node.lineno,
        "end_lineno": getattr(node, "end_lineno", node.lineno),
        "is_async": isinstance(node, ast.AsyncFunctionDef),
        "decorators": [decorator_info(d) for d in node.decorator_list],
        "calls": collect_calls(node.body),
    }


def parse_file(path, root):
    try:
        with open(path, "r", encoding="utf-8") as fh:
            source = fh.read()
        tree = ast.parse(source, filename=path)
    except (SyntaxError, UnicodeDecodeError, OSError):
        return None
    rel = os.path.relpath(path, root).replace("\\", "/")
    classes = [parse_class(n) for n in tree.body if isinstance(n, ast.ClassDef)]
    functions = [function_info(n) for n in tree.body if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef))]
    return {
        "file": rel,
        "lines": source.count("\n") + 1,
        "imports": parse_imports(tree),
        "routers": parse_routers(tree),
        "includes": parse_includes(tree),
        "classes": classes,
        "functions": functions,
    }


def main():
    if len(sys.argv) < 2:
        print(json.dumps({"error": "usage: ast_dump.py <root>"}))
        return 1
    root = os.path.abspath(sys.argv[1])
    files = []
    skipped = 0
    for path in walk_py(root):
        info = parse_file(path, root)
        if info is None:
            skipped += 1
            continue
        files.append(info)
    print(json.dumps({"root": root, "files": files, "skipped": skipped}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
