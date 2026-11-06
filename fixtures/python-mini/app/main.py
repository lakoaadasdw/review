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


@router.get("/conversations")
async def list_conversations(limit: int = 20) -> list:
    """演示：原生 SQL 字面量（text() 包裹）——静态可抓"""
    rows = await db.fetch_all(
        text("SELECT id, status FROM conversations WHERE status = :status ORDER BY id DESC LIMIT :limit"),
        {"status": "open", "limit": limit},
    )
    return rows


async def touch_conversation(cid: int) -> None:
    """演示：cursor.execute 原生 SQL"""
    await cursor.execute("UPDATE conversations SET status = %s WHERE id = %s", ("open", cid))


async def purge_conversation(cid: int) -> None:
    """演示：f-string 拼出来的 SQL（动态部分用 {} 占位）"""
    await conn.execute(f"DELETE FROM conversations WHERE id = {cid}")
