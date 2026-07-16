import os
from datetime import datetime, timedelta
from jose import JWTError, jwt
import bcrypt

SECRET_KEY = os.getenv("JWT_SECRET", "fieldpulse-secret-key-change-in-production-2024")
ALGORITHM = "HS256"
ACCESS_TOKEN_EXPIRE_MINUTES = 60 * 24       # 24 hours
REFRESH_TOKEN_EXPIRE_DAYS = 30

def hash_password(plain: str) -> str:
    return bcrypt.hashpw(plain.encode(), bcrypt.gensalt()).decode()

def verify_password(plain: str, hashed: str) -> bool:
    return bcrypt.checkpw(plain.encode(), hashed.encode())

def create_access_token(user_id: str, email: str, role: str) -> str:
    expire = datetime.utcnow() + timedelta(minutes=ACCESS_TOKEN_EXPIRE_MINUTES)
    return jwt.encode(
        {"sub": user_id, "email": email, "role": role, "exp": expire},
        SECRET_KEY, algorithm=ALGORITHM
    )

def create_token(payload: dict, expire_minutes: int = ACCESS_TOKEN_EXPIRE_MINUTES) -> str:
    data = {**payload, "exp": datetime.utcnow() + timedelta(minutes=expire_minutes)}
    return jwt.encode(data, SECRET_KEY, algorithm=ALGORITHM)

def create_refresh_token(user_id: str) -> tuple[str, datetime]:
    expire = datetime.utcnow() + timedelta(days=REFRESH_TOKEN_EXPIRE_DAYS)
    token = jwt.encode(
        {"sub": user_id, "type": "refresh", "exp": expire},
        SECRET_KEY, algorithm=ALGORITHM
    )
    return token, expire

def decode_token(token: str) -> dict:
    return jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
