"""python-mini：apiflow Python 适配器的回归夹具（FastAPI 风格，可直接被静态解析）。

只用于验证解析/调用链，不依赖 fastapi 实际安装：
apiflow 只读源码；若要跑起来看真实链路，用 fixtures/python-mini/mock-server.mjs。
"""
from fastapi import APIRouter, Depends, FastAPI

from app.services import auth as auth_service

app = FastAPI(title="python-mini")
router = APIRouter(prefix="/auth", tags=["auth"])


@router.post("/login")
async def login(username: str, password: str) -> dict:
    user = auth_service.authenticate(username, password)
    token = auth_service.issue_token(user)
    return {"token": token, "user": user}


@router.get("/me")
async def me(user: dict = Depends(auth_service.current_user)) -> dict:
    return auth_service.profile(user)


@app.get("/health")
def health() -> dict:
    return {"ok": True}
