import os, uuid, shutil, logging
from datetime import datetime, timedelta
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, Depends, HTTPException, UploadFile, File, Header, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import JSONResponse
from pydantic import BaseModel, EmailStr
from sqlalchemy.orm import Session
from jose import JWTError

from database import get_db, engine, Base
from models import User, RefreshToken, AttendanceLog, Task, UploadedFile
from auth import (
    hash_password, verify_password,
    create_access_token, create_refresh_token, decode_token
)
from seed import seed

logging.basicConfig(level=logging.INFO)
log = logging.getLogger(__name__)

# ── Bootstrap ──────────────────────────────────────────────────────────────
Base.metadata.create_all(bind=engine)
seed()

UPLOAD_DIR = Path(os.getenv("UPLOAD_DIR", "/app/data/uploads"))
UPLOAD_DIR.mkdir(parents=True, exist_ok=True)

app = FastAPI(title="FieldPulse API", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.mount("/uploads", StaticFiles(directory=str(UPLOAD_DIR)), name="uploads")

BASE_URL = os.getenv("BASE_URL", "http://167.233.90.245:8000")


# ── Auth helpers ────────────────────────────────────────────────────────────
def get_current_user(authorization: Optional[str] = Header(None), db: Session = Depends(get_db)) -> User:
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Not authenticated")
    token = authorization.split(" ", 1)[1]
    try:
        payload = decode_token(token)
        user_id = payload.get("sub")
    except JWTError:
        raise HTTPException(status_code=401, detail="Invalid or expired token")
    user = db.query(User).filter(User.id == user_id, User.is_active == True).first()
    if not user:
        raise HTTPException(status_code=401, detail="User not found")
    return user


# ── Schemas ─────────────────────────────────────────────────────────────────
class LoginRequest(BaseModel):
    email: str
    password: str
    device_uuid: Optional[str] = None

class RefreshRequest(BaseModel):
    refresh_token: str

class PunchInRequest(BaseModel):
    selfie_url: Optional[str] = None
    latitude: Optional[float] = None
    longitude: Optional[float] = None

class PunchOutRequest(BaseModel):
    attendance_log_id: str
    selfie_url: Optional[str] = None
    latitude: Optional[float] = None
    longitude: Optional[float] = None

class FormSubmitRequest(BaseModel):
    form_data: dict


# ── Routes: Health ──────────────────────────────────────────────────────────
@app.get("/")
def root():
    return {"status": "ok", "service": "FieldPulse API", "version": "1.0.0"}

@app.get("/api/time")
def get_server_time():
    now = datetime.utcnow()
    return {
        "datetime": now.isoformat() + "Z",
        "timestamp": now.timestamp(),
        "timezone": "UTC"
    }


# ── Routes: Auth ────────────────────────────────────────────────────────────
@app.post("/api/auth/login")
def login(req: LoginRequest, db: Session = Depends(get_db)):
    user = db.query(User).filter(
        User.email == req.email.lower().strip(),
        User.is_active == True
    ).first()

    if not user or not verify_password(req.password, user.password):
        raise HTTPException(status_code=401, detail="Invalid email or password")

    # Update device UUID if provided
    if req.device_uuid:
        user.device_uuid = req.device_uuid
        db.commit()

    access_token = create_access_token(user.id, user.email, user.role)
    refresh_token_str, expires_at = create_refresh_token(user.id)

    # Store refresh token
    db.add(RefreshToken(user_id=user.id, token=refresh_token_str, expires_at=expires_at))
    db.commit()

    return {
        "access_token": access_token,
        "refresh_token": refresh_token_str,
        "token_type": "bearer",
        "role": user.role,
        "name": user.name,
        "email": user.email,
        "user_id": user.id,
    }

@app.post("/api/auth/refresh")
def refresh(req: RefreshRequest, db: Session = Depends(get_db)):
    try:
        payload = decode_token(req.refresh_token)
        user_id = payload.get("sub")
    except JWTError:
        raise HTTPException(status_code=401, detail="Invalid refresh token")

    rt = db.query(RefreshToken).filter(
        RefreshToken.token == req.refresh_token,
        RefreshToken.revoked == False,
        RefreshToken.expires_at > datetime.utcnow()
    ).first()
    if not rt:
        raise HTTPException(status_code=401, detail="Refresh token expired or revoked")

    user = db.query(User).filter(User.id == user_id, User.is_active == True).first()
    if not user:
        raise HTTPException(status_code=401, detail="User not found")

    # Rotate tokens
    rt.revoked = True
    access_token = create_access_token(user.id, user.email, user.role)
    new_refresh, expires_at = create_refresh_token(user.id)
    db.add(RefreshToken(user_id=user.id, token=new_refresh, expires_at=expires_at))
    db.commit()

    return {
        "access_token": access_token,
        "refresh_token": new_refresh,
        "token_type": "bearer",
    }


# ── Routes: Tasks ───────────────────────────────────────────────────────────
@app.get("/api/tasks/my-tasks")
def my_tasks(current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    tasks = db.query(Task).filter(Task.assignee_id == current_user.id).order_by(Task.scheduled_time).all()
    return [
        {
            "id": t.id,
            "title": t.title,
            "description": t.description,
            "location": t.location,
            "latitude": t.latitude,
            "longitude": t.longitude,
            "scheduled_time": t.scheduled_time.isoformat() if t.scheduled_time else None,
            "status": t.status,
            "client_name": t.client_name,
            "form_fields": t.form_fields or [],
        }
        for t in tasks
    ]

@app.post("/api/tasks/{task_id}/submit-form")
def submit_form(task_id: str, req: FormSubmitRequest,
                current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    task = db.query(Task).filter(Task.id == task_id, Task.assignee_id == current_user.id).first()
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")
    task.form_data = req.form_data
    task.status = "completed"
    db.commit()
    return {"success": True, "message": "Form submitted successfully"}


# ── Routes: Attendance ──────────────────────────────────────────────────────
@app.post("/api/attendance/punch-in")
def punch_in(req: PunchInRequest,
             current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    # Check if already punched in
    active = db.query(AttendanceLog).filter(
        AttendanceLog.user_id == current_user.id,
        AttendanceLog.punch_out_time == None
    ).first()
    if active:
        raise HTTPException(status_code=400, detail="Already punched in. Please punch out first.")

    now = datetime.utcnow()
    log_entry = AttendanceLog(
        user_id=current_user.id,
        punch_in_time=now,
        latitude=req.latitude,
        longitude=req.longitude,
        selfie_url=req.selfie_url,
        status="active",
    )
    db.add(log_entry)
    db.commit()
    db.refresh(log_entry)

    return {
        "id": log_entry.id,
        "attendance_log_id": log_entry.id,
        "punch_in_time": now.isoformat() + "Z",
        "message": "Punched in successfully",
    }

@app.post("/api/attendance/punch-out")
def punch_out(req: PunchOutRequest,
              current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    log_entry = db.query(AttendanceLog).filter(
        AttendanceLog.id == req.attendance_log_id,
        AttendanceLog.user_id == current_user.id,
        AttendanceLog.punch_out_time == None
    ).first()
    if not log_entry:
        raise HTTPException(status_code=404, detail="Active attendance log not found")

    now = datetime.utcnow()
    delta = now - log_entry.punch_in_time
    total_hours = delta.total_seconds() / 3600

    log_entry.punch_out_time = now
    log_entry.total_hours = round(total_hours, 2)
    log_entry.status = "completed"
    if req.selfie_url:
        log_entry.selfie_url = req.selfie_url
    db.commit()

    return {
        "id": log_entry.id,
        "punch_out_time": now.isoformat() + "Z",
        "total_hours": round(total_hours, 2),
        "message": "Punched out successfully",
    }

@app.get("/api/attendance/logs")
def attendance_logs(limit: int = 10,
                    current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    logs = (
        db.query(AttendanceLog)
        .filter(AttendanceLog.user_id == current_user.id)
        .order_by(AttendanceLog.punch_in_time.desc())
        .limit(limit)
        .all()
    )
    return [
        {
            "id": l.id,
            "punch_in_time": l.punch_in_time.isoformat() + "Z",
            "punch_out_time": l.punch_out_time.isoformat() + "Z" if l.punch_out_time else None,
            "total_hours": l.total_hours,
            "status": l.status,
        }
        for l in logs
    ]


# ── Routes: Profile ─────────────────────────────────────────────────────────
@app.get("/api/profile/stats")
def profile_stats(current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    now = datetime.utcnow()
    month_start = now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)

    logs = db.query(AttendanceLog).filter(
        AttendanceLog.user_id == current_user.id,
        AttendanceLog.punch_in_time >= month_start,
        AttendanceLog.status == "completed"
    ).all()

    total_shifts = len(logs)
    total_hours = sum(l.total_hours or 0 for l in logs)

    completed_tasks = db.query(Task).filter(
        Task.assignee_id == current_user.id,
        Task.status == "completed"
    ).count()

    return {
        "total_shifts": total_shifts,
        "total_hours": round(total_hours, 1),
        "km_this_month": round(total_shifts * 12.5, 1),
        "tasks_completed": completed_tasks,
        "name": current_user.name,
        "email": current_user.email,
        "role": current_user.role,
    }


# ── Routes: Admin ───────────────────────────────────────────────────────────
def require_admin(current_user: User = Depends(get_current_user)) -> User:
    if current_user.role not in ("admin", "manager"):
        raise HTTPException(status_code=403, detail="Admin access required")
    return current_user

@app.get("/api/admin/users")
def admin_list_users(admin: User = Depends(require_admin), db: Session = Depends(get_db)):
    users = db.query(User).order_by(User.created_at).all()
    return [
        {
            "id": u.id, "name": u.name, "email": u.email,
            "role": u.role, "is_active": u.is_active,
            "created_at": u.created_at.isoformat() if u.created_at else None,
        }
        for u in users
    ]

@app.get("/api/admin/tasks")
def admin_list_tasks(admin: User = Depends(require_admin), db: Session = Depends(get_db)):
    tasks = db.query(Task).order_by(Task.created_at.desc()).all()
    result = []
    for t in tasks:
        assignee_name = t.assignee.name if t.assignee else None
        result.append({
            "id": t.id, "title": t.title, "location": t.location,
            "status": t.status, "client_name": t.client_name,
            "assignee_name": assignee_name,
            "scheduled_time": t.scheduled_time.isoformat() if t.scheduled_time else None,
        })
    return result

@app.get("/api/admin/attendance")
def admin_list_attendance(admin: User = Depends(require_admin), db: Session = Depends(get_db)):
    logs = db.query(AttendanceLog).order_by(AttendanceLog.punch_in_time.desc()).limit(100).all()
    result = []
    for l in logs:
        result.append({
            "id": l.id,
            "user_name": l.user.name if l.user else "Unknown",
            "user_email": l.user.email if l.user else "",
            "punch_in_time": l.punch_in_time.isoformat() + "Z",
            "punch_out_time": l.punch_out_time.isoformat() + "Z" if l.punch_out_time else None,
            "total_hours": l.total_hours,
            "status": l.status,
        })
    return result

@app.get("/api/admin/stats")
def admin_stats(admin: User = Depends(require_admin), db: Session = Depends(get_db)):
    total_users = db.query(User).filter(User.role == "field_worker").count()
    total_tasks = db.query(Task).count()
    completed_tasks = db.query(Task).filter(Task.status == "completed").count()
    active_shifts = db.query(AttendanceLog).filter(AttendanceLog.status == "active").count()
    return {
        "total_workers": total_users,
        "total_tasks": total_tasks,
        "completed_tasks": completed_tasks,
        "active_shifts": active_shifts,
    }

class CreateUserRequest(BaseModel):
    name: str
    email: str
    password: str
    role: str = "field_worker"

@app.post("/api/admin/users")
def admin_create_user(req: CreateUserRequest, admin: User = Depends(require_admin), db: Session = Depends(get_db)):
    exists = db.query(User).filter(User.email == req.email.lower().strip()).first()
    if exists:
        raise HTTPException(status_code=400, detail="Email already exists")
    user = User(
        name=req.name,
        email=req.email.lower().strip(),
        password=hash_password(req.password),
        role=req.role,
    )
    db.add(user)
    db.commit()
    db.refresh(user)
    return {"id": user.id, "name": user.name, "email": user.email, "role": user.role}

class CreateTaskRequest(BaseModel):
    title: str
    description: str = ""
    location: str = ""
    client_name: str = ""
    assignee_email: str = ""
    scheduled_time: Optional[str] = None

@app.post("/api/admin/tasks")
def admin_create_task(req: CreateTaskRequest, admin: User = Depends(require_admin), db: Session = Depends(get_db)):
    assignee = None
    if req.assignee_email:
        assignee = db.query(User).filter(User.email == req.assignee_email.lower().strip()).first()
    sched = None
    if req.scheduled_time:
        try:
            sched = datetime.fromisoformat(req.scheduled_time.replace("Z", ""))
        except Exception:
            pass
    task = Task(
        title=req.title, description=req.description,
        location=req.location, client_name=req.client_name,
        assignee_id=assignee.id if assignee else None,
        scheduled_time=sched, status="pending",
    )
    db.add(task)
    db.commit()
    db.refresh(task)
    return {"id": task.id, "title": task.title, "status": task.status}


# ── Routes: File Upload ─────────────────────────────────────────────────────
@app.post("/api/mock-s3/upload")
async def upload_file(file: UploadFile = File(...),
                      current_user: User = Depends(get_current_user),
                      db: Session = Depends(get_db)):
    ext = Path(file.filename).suffix if file.filename else ".jpg"
    filename = f"{uuid.uuid4()}{ext}"
    dest = UPLOAD_DIR / filename

    with dest.open("wb") as f:
        shutil.copyfileobj(file.file, f)

    url = f"{BASE_URL}/uploads/{filename}"
    db.add(UploadedFile(filename=filename, url=url))
    db.commit()

    return {"url": url, "file_url": url, "filename": filename}
