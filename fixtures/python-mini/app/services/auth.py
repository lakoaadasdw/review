"""python-mini 的服务层：验证「路由函数 → service 函数 → 再下一层」的静态调用链。"""


def authenticate(username: str, password: str) -> dict:
    if not _check_password(username, password):
        raise PermissionError("invalid credentials")
    return {"name": username, "role": "admin"}


def _check_password(username: str, password: str) -> bool:
    return bool(username) and bool(password)


def issue_token(user: dict) -> str:
    return _sign({"sub": user["name"], "role": user["role"]})


def _sign(payload: dict) -> str:
    return "token-" + "-".join(f"{k}={v}" for k, v in sorted(payload.items()))


def current_user() -> dict:
    return {"name": "demo", "role": "admin"}


def profile(user: dict) -> dict:
    return {"name": user["name"], "role": user["role"], "token": issue_token(user)}
