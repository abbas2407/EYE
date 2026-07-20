import os, uuid, shutil, logging, math
from datetime import datetime, timedelta
from pathlib import Path
from typing import Optional, List

from fastapi import FastAPI, Depends, HTTPException, UploadFile, File, Header, BackgroundTasks
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from sqlalchemy.orm import Session
from jose import JWTError
import httpx, io

from database import get_db, engine, Base
from sqlalchemy import text
from models import (User, RefreshToken, AttendanceLog, Task, UploadedFile,
                    LeaveBalance, Leave, ChatRoom, ChatMember, Message, GPSPing, PushToken,
                    Client, Site, SalaryConfig)
from auth import hash_password, verify_password, create_access_token, create_refresh_token, decode_token
from seed import seed
import vendor_models
from vendor_routes import router as vendor_router

logging.basicConfig(level=logging.INFO)
log = logging.getLogger(__name__)

Base.metadata.create_all(bind=engine)

# Schema migrations for older databases
with engine.connect() as _conn:
    for _sql in [
        "ALTER TABLE users ADD COLUMN plain_password VARCHAR",
        "ALTER TABLE chat_members ADD COLUMN last_read_at DATETIME",
        "ALTER TABLE users ADD COLUMN company_id VARCHAR DEFAULT 'default'",
        "UPDATE users SET company_id = 'default' WHERE company_id IS NULL",
        "ALTER TABLE tasks ADD COLUMN company_id VARCHAR DEFAULT 'default'",
        "UPDATE tasks SET company_id = 'default' WHERE company_id IS NULL",
        "ALTER TABLE clients ADD COLUMN company_id VARCHAR DEFAULT 'default'",
        "UPDATE clients SET company_id = 'default' WHERE company_id IS NULL",
        "ALTER TABLE sites ADD COLUMN company_id VARCHAR DEFAULT 'default'",
        "UPDATE sites SET company_id = 'default' WHERE company_id IS NULL",
    ]:
        try:
            _conn.execute(text(_sql))
            _conn.commit()
        except Exception:
            pass  # Column already exists or update found no rows

seed()

UPLOAD_DIR = Path(os.getenv("UPLOAD_DIR", "/app/data/uploads"))
UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
BASE_URL = os.getenv("BASE_URL", "http://167.233.90.245:8000")
GOOGLE_MAPS_API_KEY = "AIzaSyAJHF-B2ulEDrxStgKH4NS7szhFdjErnos"
GEOAPIFY_KEY = os.getenv("GEOAPIFY_KEY", "58776059a2734444a13b6f1a862b765a")

app = FastAPI(title="FieldPulse API", version="2.0.0")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_credentials=True,
                   allow_methods=["*"], allow_headers=["*"])
app.mount("/uploads", StaticFiles(directory=str(UPLOAD_DIR)), name="uploads")
app.include_router(vendor_router)


# ── Auth helpers ──────────────────────────────────────────────────────────────
def get_current_user(authorization: Optional[str] = Header(None), db: Session = Depends(get_db)) -> User:
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Not authenticated")
    try:
        payload = decode_token(authorization.split(" ", 1)[1])
        user_id = payload.get("sub")
    except JWTError:
        raise HTTPException(status_code=401, detail="Invalid or expired token")
    user = db.query(User).filter(User.id == user_id, User.is_active == True).first()
    if not user:
        raise HTTPException(status_code=401, detail="User not found")
    return user

def require_admin(current_user: User = Depends(get_current_user)) -> User:
    if current_user.role not in ("admin", "manager"):
        raise HTTPException(status_code=403, detail="Admin access required")
    return current_user

def haversine_m(lat1, lng1, lat2, lng2) -> float:
    R = 6371000
    d_lat = math.radians(lat2 - lat1)
    d_lng = math.radians(lng2 - lng1)
    a = math.sin(d_lat/2)**2 + math.cos(math.radians(lat1)) * math.cos(math.radians(lat2)) * math.sin(d_lng/2)**2
    return R * 2 * math.atan2(math.sqrt(a), math.sqrt(1-a))

async def send_push(tokens: list, title: str, body: str, data: dict = {}):
    if not tokens:
        return
    messages = [{"to": t, "title": title, "body": body, "data": data,
                 "sound": "default", "priority": "high"} for t in tokens]
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            await client.post("https://exp.host/--/api/v2/push/send", json=messages)
    except Exception as e:
        log.warning(f"Push notification failed: {e}")

def get_admin_tokens(db: Session, company_id: str = "default") -> list:
    admins = db.query(User).filter(
        User.role.in_(["admin", "manager"]),
        User.company_id == company_id
    ).all()
    tokens = []
    for a in admins:
        for pt in a.push_tokens:
            tokens.append(pt.token)
    return tokens


# ── Schemas ───────────────────────────────────────────────────────────────────
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
    check_in_note: Optional[str] = None

class PunchOutRequest(BaseModel):
    attendance_log_id: str
    selfie_url: Optional[str] = None
    latitude: Optional[float] = None
    longitude: Optional[float] = None

class FormSubmitRequest(BaseModel):
    form_data: dict

class GPSPingItem(BaseModel):
    latitude: float
    longitude: float
    accuracy: Optional[float] = None
    timestamp: str

class GPSBatchRequest(BaseModel):
    pings: List[GPSPingItem]

class LeaveApplyRequest(BaseModel):
    leave_type: str
    start_date: str
    end_date: str
    reason: Optional[str] = None

class SendMessageRequest(BaseModel):
    content: str

class PushTokenRequest(BaseModel):
    token: str
    platform: Optional[str] = None

class PhotoUpdateRequest(BaseModel):
    photo_url: str

class CreateUserRequest(BaseModel):
    name: str
    email: str
    password: str
    role: str = "field_worker"

class CreateTaskRequest(BaseModel):
    title: str
    description: str = ""
    location: str = ""
    client_name: str = ""
    assignee_email: str = ""
    scheduled_time: Optional[str] = None
    latitude: Optional[float] = None
    longitude: Optional[float] = None

class BulkTaskRequest(BaseModel):
    title: str
    description: str = ""
    location: str = ""
    client_name: str = ""
    assignee_emails: List[str]
    scheduled_time: Optional[str] = None
    latitude: Optional[float] = None
    longitude: Optional[float] = None

class LeaveActionRequest(BaseModel):
    status: str  # approved | rejected

class CreateClientRequest(BaseModel):
    name: str
    client_id: Optional[str] = None
    visibility: Optional[str] = "Everyone"
    contact_name: Optional[str] = None
    contact_code: Optional[str] = "+91"
    contact_number: Optional[str] = None
    latitude: Optional[float] = None
    longitude: Optional[float] = None
    address_line1: Optional[str] = None
    address_line2: Optional[str] = None
    city: Optional[str] = None
    district: Optional[str] = None
    state: Optional[str] = None
    country: Optional[str] = None
    pin_code: Optional[str] = None
    radius: Optional[float] = 200.0
    employee_override: Optional[bool] = False
    description: Optional[str] = None
    email: Optional[str] = None
    category: Optional[str] = None

class CreateSiteRequest(BaseModel):
    name: str
    email: Optional[str] = None
    site_id: Optional[str] = None
    contact_name: Optional[str] = None
    contact_code: Optional[str] = "+91"
    contact_number: Optional[str] = None
    description: Optional[str] = None
    site_type: Optional[str] = None
    latitude: Optional[float] = None
    longitude: Optional[float] = None
    address: Optional[str] = None
    radius: Optional[float] = 200.0
    city: Optional[str] = None
    pin_code: Optional[str] = None
    client_id: Optional[str] = None


# ── Health ────────────────────────────────────────────────────────────────────
@app.get("/")
def root():
    return {"status": "ok", "service": "FieldPulse API", "version": "2.0.0"}

@app.get("/health")
def health(db: Session = Depends(get_db)):
    try:
        db.execute(text("SELECT 1"))
        return {"status": "ok", "db": "ok", "ts": datetime.utcnow().isoformat()}
    except Exception as e:
        raise HTTPException(status_code=503, detail=f"DB unavailable: {e}")

@app.get("/api/time")
def get_server_time():
    now = datetime.utcnow()
    return {"datetime": now.isoformat() + "Z", "timestamp": now.timestamp(), "timezone": "UTC"}


# ── Auth ──────────────────────────────────────────────────────────────────────
@app.post("/api/auth/login")
def login(req: LoginRequest, db: Session = Depends(get_db)):
    user = db.query(User).filter(User.email == req.email.lower().strip(), User.is_active == True).first()
    if not user or not verify_password(req.password, user.password):
        raise HTTPException(status_code=401, detail="Invalid email or password")
    if req.device_uuid:
        user.device_uuid = req.device_uuid
        db.commit()
    access = create_access_token(user.id, user.email, user.role)
    refresh, expires = create_refresh_token(user.id)
    db.add(RefreshToken(user_id=user.id, token=refresh, expires_at=expires))
    db.commit()
    return {"access_token": access, "refresh_token": refresh, "token_type": "bearer",
            "role": user.role, "name": user.name, "email": user.email,
            "user_id": user.id, "photo_url": user.photo_url}

@app.post("/api/auth/refresh")
def refresh_token(req: RefreshRequest, db: Session = Depends(get_db)):
    try:
        payload = decode_token(req.refresh_token)
        user_id = payload.get("sub")
    except JWTError:
        raise HTTPException(status_code=401, detail="Invalid refresh token")
    rt = db.query(RefreshToken).filter(RefreshToken.token == req.refresh_token,
                                        RefreshToken.revoked == False,
                                        RefreshToken.expires_at > datetime.utcnow()).first()
    if not rt:
        raise HTTPException(status_code=401, detail="Refresh token expired or revoked")
    user = db.query(User).filter(User.id == user_id, User.is_active == True).first()
    if not user:
        raise HTTPException(status_code=401, detail="User not found")
    rt.revoked = True
    access = create_access_token(user.id, user.email, user.role)
    new_refresh, expires = create_refresh_token(user.id)
    db.add(RefreshToken(user_id=user.id, token=new_refresh, expires_at=expires))
    db.commit()
    return {"access_token": access, "refresh_token": new_refresh, "token_type": "bearer"}


# ── Profile ───────────────────────────────────────────────────────────────────
@app.get("/api/profile/me")
def get_profile(current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    now = datetime.utcnow()
    month_start = now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    logs = db.query(AttendanceLog).filter(AttendanceLog.user_id == current_user.id,
                                           AttendanceLog.punch_in_time >= month_start,
                                           AttendanceLog.status == "completed").all()
    completed = db.query(Task).filter(Task.assignee_id == current_user.id, Task.status == "completed").count()
    total_tasks = db.query(Task).filter(Task.assignee_id == current_user.id).count()
    return {
        "id": current_user.id, "name": current_user.name, "email": current_user.email,
        "role": current_user.role, "photo_url": current_user.photo_url,
        "stats": {
            "total_shifts": len(logs),
            "total_hours": round(sum(l.total_hours or 0 for l in logs), 1),
            "km_this_month": round(len(logs) * 12.5, 1),
            "tasks_completed": completed,
            "total_tasks": total_tasks,
            "completion_rate": round((completed / total_tasks * 100) if total_tasks else 0, 1),
        }
    }

@app.get("/api/profile/stats")
def profile_stats(current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    now = datetime.utcnow()
    month_start = now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    logs = db.query(AttendanceLog).filter(AttendanceLog.user_id == current_user.id,
                                           AttendanceLog.punch_in_time >= month_start,
                                           AttendanceLog.status == "completed").all()
    completed = db.query(Task).filter(Task.assignee_id == current_user.id, Task.status == "completed").count()
    return {
        "total_shifts": len(logs), "total_hours": round(sum(l.total_hours or 0 for l in logs), 1),
        "km_this_month": round(len(logs) * 12.5, 1), "tasks_completed": completed,
        "name": current_user.name, "email": current_user.email, "role": current_user.role,
        "photo_url": current_user.photo_url,
    }

@app.put("/api/profile/photo")
def update_photo(req: PhotoUpdateRequest, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    current_user.photo_url = req.photo_url
    db.commit()
    return {"photo_url": req.photo_url}


# ── Tasks ─────────────────────────────────────────────────────────────────────
@app.get("/api/tasks/my-tasks")
def my_tasks(current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    tasks = db.query(Task).filter(Task.assignee_id == current_user.id).order_by(Task.scheduled_time).all()
    return [{"id": t.id, "title": t.title, "description": t.description, "location": t.location,
             "latitude": t.latitude, "longitude": t.longitude,
             "scheduled_time": t.scheduled_time.isoformat() if t.scheduled_time else None,
             "status": t.status, "client_name": t.client_name,
             "form_fields": t.form_fields or []} for t in tasks]

@app.post("/api/tasks/{task_id}/submit-form")
def submit_form(task_id: str, req: FormSubmitRequest,
                current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    task = db.query(Task).filter(Task.id == task_id, Task.assignee_id == current_user.id).first()
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")
    task.form_data = req.form_data
    task.status = "completed"
    db.commit()
    return {"success": True, "message": "Form submitted"}


# ── Attendance ────────────────────────────────────────────────────────────────
@app.post("/api/attendance/punch-in")
async def punch_in(req: PunchInRequest, background: BackgroundTasks,
                   current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    active = db.query(AttendanceLog).filter(AttendanceLog.user_id == current_user.id,
                                             AttendanceLog.punch_out_time == None).first()
    if active:
        raise HTTPException(status_code=400, detail="Already punched in. Punch out first.")
    now = datetime.utcnow()
    entry = AttendanceLog(user_id=current_user.id, punch_in_time=now,
                          latitude=req.latitude, longitude=req.longitude,
                          selfie_url=req.selfie_url, check_in_note=req.check_in_note, status="active")
    db.add(entry)
    db.commit()
    db.refresh(entry)

    admin_tokens = get_admin_tokens(db, current_user.company_id or "default")
    time_str = now.strftime("%I:%M %p")
    background.add_task(send_push, admin_tokens, "🟢 Punch In",
                        f"{current_user.name} punched in at {time_str}",
                        {"type": "punch_in", "user_id": current_user.id})
    return {"id": entry.id, "attendance_log_id": entry.id,
            "punch_in_time": now.isoformat() + "Z", "message": "Punched in"}

@app.post("/api/attendance/punch-out")
async def punch_out(req: PunchOutRequest, background: BackgroundTasks,
                    current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    entry = db.query(AttendanceLog).filter(AttendanceLog.id == req.attendance_log_id,
                                            AttendanceLog.user_id == current_user.id,
                                            AttendanceLog.punch_out_time == None).first()
    if not entry:
        raise HTTPException(status_code=404, detail="Active attendance log not found")
    now = datetime.utcnow()
    delta = now - entry.punch_in_time
    total_hours = round(delta.total_seconds() / 3600, 2)
    entry.punch_out_time = now
    entry.total_hours = total_hours
    entry.status = "completed"
    if req.selfie_url:
        entry.selfie_url = req.selfie_url
    db.commit()

    admin_tokens = get_admin_tokens(db, current_user.company_id or "default")
    background.add_task(send_push, admin_tokens, "🔴 Punch Out",
                        f"{current_user.name} punched out — {total_hours:.1f}h worked",
                        {"type": "punch_out", "user_id": current_user.id})
    return {"id": entry.id, "punch_out_time": now.isoformat() + "Z",
            "total_hours": total_hours, "message": "Punched out"}

@app.get("/api/attendance/summary")
def attendance_summary(current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    """Lightweight endpoint: returns current punch state for the mobile app.
    Searches ALL dates so stale active logs from previous days are detected."""
    active = db.query(AttendanceLog).filter(
        AttendanceLog.user_id == current_user.id,
        AttendanceLog.punch_out_time == None,
        AttendanceLog.status == "active"
    ).order_by(AttendanceLog.punch_in_time.desc()).first()
    return {
        "is_punched_in": active is not None,
        "punch_in_time": active.punch_in_time.isoformat() + "Z" if active else None,
        "attendance_log_id": active.id if active else None,
    }

@app.get("/api/attendance/logs")
def attendance_logs(limit: int = 10, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    logs = (db.query(AttendanceLog).filter(AttendanceLog.user_id == current_user.id)
            .order_by(AttendanceLog.punch_in_time.desc()).limit(limit).all())
    return [{"id": l.id,
             "punch_in_time": l.punch_in_time.isoformat() + "Z",
             "punch_out_time": l.punch_out_time.isoformat() + "Z" if l.punch_out_time else None,
             "total_hours": l.total_hours, "status": l.status,
             "check_in_note": l.check_in_note} for l in logs]

@app.get("/api/daily-summary")
def daily_summary(current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    today_start = datetime.utcnow().replace(hour=0, minute=0, second=0, microsecond=0)
    today_end   = today_start + timedelta(days=1)
    today_logs = db.query(AttendanceLog).filter(AttendanceLog.user_id == current_user.id,
                                           AttendanceLog.punch_in_time >= today_start,
                                           AttendanceLog.punch_in_time < today_end).all()
    # Check for ANY active log (not just today) so stale punch-ins are detected
    active_log = db.query(AttendanceLog).filter(
        AttendanceLog.user_id == current_user.id,
        AttendanceLog.punch_out_time == None,
        AttendanceLog.status == "active"
    ).order_by(AttendanceLog.punch_in_time.desc()).first()
    tasks = db.query(Task).filter(Task.assignee_id == current_user.id,
                                   Task.scheduled_time >= today_start,
                                   Task.scheduled_time < today_end).all()
    total_hours = sum(l.total_hours or 0 for l in today_logs if l.status == "completed")
    # Total distance from GPS pings today
    today_pings = (db.query(GPSPing)
                   .filter(GPSPing.user_id == current_user.id,
                           GPSPing.timestamp >= today_start,
                           GPSPing.timestamp < today_end)
                   .order_by(GPSPing.timestamp).all())
    km_today = 0.0
    for i in range(1, len(today_pings)):
        p1, p2 = today_pings[i - 1], today_pings[i]
        km_today += haversine_m(p1.latitude, p1.longitude, p2.latitude, p2.longitude) / 1000
    return {
        "date": today_start.date().isoformat(),
        "is_punched_in": active_log is not None,
        "punch_in_time": active_log.punch_in_time.isoformat() + "Z" if active_log else None,
        "attendance_log_id": active_log.id if active_log else None,
        "total_hours_today": round(total_hours, 2),
        "total_shifts": len(today_logs),
        "tasks_today": len(tasks),
        "tasks_completed_today": sum(1 for t in tasks if t.status == "completed"),
        "km_today": round(km_today, 2),
        "tasks": [{"id": t.id, "title": t.title, "status": t.status, "location": t.location,
                   "scheduled_time": t.scheduled_time.isoformat() if t.scheduled_time else None}
                  for t in tasks],
    }


# ── GPS Tracking ──────────────────────────────────────────────────────────────
@app.post("/api/gps/batch")
def gps_batch(req: GPSBatchRequest, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    active_task = db.query(Task).filter(Task.assignee_id == current_user.id,
                                         Task.status.in_(["in_route", "upcoming"])).first()
    breaches = []
    for p in req.pings:
        try:
            ts = datetime.fromisoformat(p.timestamp.replace("Z", ""))
        except Exception:
            ts = datetime.utcnow()
        is_breach = False
        if active_task and active_task.latitude and active_task.longitude:
            dist = haversine_m(p.latitude, p.longitude, active_task.latitude, active_task.longitude)
            if dist > (active_task.geofence_radius or 200):
                is_breach = True
                breaches.append({"task": active_task.title, "distance_m": round(dist)})
        db.add(GPSPing(user_id=current_user.id, latitude=p.latitude, longitude=p.longitude,
                       accuracy=p.accuracy, timestamp=ts, is_breach=is_breach,
                       task_id=active_task.id if active_task else None))
    db.commit()
    return {"synced": len(req.pings), "breaches": breaches}


# ── Leave ─────────────────────────────────────────────────────────────────────
@app.get("/api/leaves/balance")
def leave_balance(current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    bal = db.query(LeaveBalance).filter(LeaveBalance.user_id == current_user.id).first()
    if not bal:
        bal = LeaveBalance(user_id=current_user.id)
        db.add(bal)
        db.commit()
        db.refresh(bal)
    return {"sick_days": bal.sick_days, "casual_days": bal.casual_days, "annual_days": bal.annual_days}

@app.post("/api/leaves/apply")
def apply_leave(req: LeaveApplyRequest, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    start = datetime.fromisoformat(req.start_date)
    end   = datetime.fromisoformat(req.end_date)
    days  = max(1.0, (end - start).days + 1.0)
    leave = Leave(user_id=current_user.id, leave_type=req.leave_type,
                  start_date=start, end_date=end, days=days, reason=req.reason)
    db.add(leave)
    db.commit()
    db.refresh(leave)
    return {"id": leave.id, "days": days, "status": leave.status, "message": "Leave application submitted"}

@app.get("/api/leaves/my-leaves")
def my_leaves(current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    leaves = db.query(Leave).filter(Leave.user_id == current_user.id).order_by(Leave.created_at.desc()).all()
    return [{"id": l.id, "leave_type": l.leave_type,
             "start_date": l.start_date.date().isoformat(),
             "end_date": l.end_date.date().isoformat(),
             "days": l.days, "reason": l.reason, "status": l.status} for l in leaves]


# ── Chat ──────────────────────────────────────────────────────────────────────
@app.get("/api/chat/rooms")
def get_rooms(current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    memberships = db.query(ChatMember).filter(ChatMember.user_id == current_user.id).all()
    rooms = []
    for m in memberships:
        room = db.query(ChatRoom).filter(ChatRoom.id == m.room_id).first()
        if not room:
            continue
        if room.room_type == "direct":
            other = (db.query(ChatMember)
                     .filter(ChatMember.room_id == room.id, ChatMember.user_id != current_user.id)
                     .first())
            display_name = other.user.name if other else room.name
        else:
            display_name = room.name
        last_msg = (db.query(Message).filter(Message.room_id == room.id)
                    .order_by(Message.created_at.desc()).first())
        # Unread count: messages from others that arrived after user last read this room
        last_read = m.last_read_at or datetime(1970, 1, 1)
        unread = (db.query(Message)
                  .filter(Message.room_id == room.id,
                          Message.sender_id != current_user.id,
                          Message.created_at > last_read)
                  .count())
        rooms.append({
            "id": room.id, "name": display_name, "room_type": room.room_type,
            "last_message": last_msg.content[:60] if last_msg else None,
            "last_message_time": last_msg.created_at.isoformat() + "Z" if last_msg else None,
            "last_sender": last_msg.sender.name if last_msg else None,
            "unread_count": unread,
        })
    return rooms

@app.post("/api/chat/rooms/{room_id}/mark-read")
def mark_room_read(room_id: str, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    member = db.query(ChatMember).filter(ChatMember.room_id == room_id, ChatMember.user_id == current_user.id).first()
    if member:
        member.last_read_at = datetime.utcnow()
        db.commit()
    return {"ok": True}

@app.get("/api/chat/messages/{room_id}")
def get_messages(room_id: str, limit: int = 50, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    member = db.query(ChatMember).filter(ChatMember.room_id == room_id, ChatMember.user_id == current_user.id).first()
    if not member:
        raise HTTPException(status_code=403, detail="Not a member of this room")
    msgs = (db.query(Message).filter(Message.room_id == room_id)
            .order_by(Message.created_at.desc()).limit(limit).all())
    return [{"id": m.id, "content": m.content, "sender_id": m.sender_id,
             "sender_name": m.sender.name, "created_at": m.created_at.isoformat() + "Z",
             "is_me": m.sender_id == current_user.id} for m in reversed(msgs)]

@app.post("/api/chat/messages/{room_id}")
async def send_message(room_id: str, req: SendMessageRequest, background: BackgroundTasks,
                       current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    member = db.query(ChatMember).filter(ChatMember.room_id == room_id, ChatMember.user_id == current_user.id).first()
    if not member:
        raise HTTPException(status_code=403, detail="Not a member of this room")
    msg = Message(room_id=room_id, sender_id=current_user.id, content=req.content.strip())
    db.add(msg)
    db.commit()
    db.refresh(msg)

    # Push to all other room members
    other_members = db.query(ChatMember).filter(ChatMember.room_id == room_id,
                                                  ChatMember.user_id != current_user.id).all()
    tokens = []
    for om in other_members:
        for pt in om.user.push_tokens:
            tokens.append(pt.token)
    room = db.query(ChatRoom).filter(ChatRoom.id == room_id).first()
    background.add_task(send_push, tokens, f"💬 {current_user.name}",
                        req.content[:100], {"type": "chat", "room_id": room_id})
    return {"id": msg.id, "content": msg.content, "sender_name": current_user.name,
            "created_at": msg.created_at.isoformat() + "Z"}


# ── Push Notifications ────────────────────────────────────────────────────────
@app.post("/api/notifications/register-token")
def register_push_token(req: PushTokenRequest, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    existing = db.query(PushToken).filter(PushToken.token == req.token).first()
    if not existing:
        db.add(PushToken(user_id=current_user.id, token=req.token, platform=req.platform))
        db.commit()
    return {"registered": True}


# ── File Upload ───────────────────────────────────────────────────────────────
@app.post("/api/mock-s3/upload")
async def upload_file(file: UploadFile = File(...),
                      current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    ext = Path(file.filename).suffix if file.filename else ".jpg"
    filename = f"{uuid.uuid4()}{ext}"
    dest = UPLOAD_DIR / filename
    with dest.open("wb") as f:
        shutil.copyfileobj(file.file, f)
    url = f"{BASE_URL}/uploads/{filename}"
    db.add(UploadedFile(filename=filename, url=url))
    db.commit()
    return {"url": url, "file_url": url, "filename": filename}


# ── Places Proxy (Geoapify) ───────────────────────────────────────────────────
_GEO_BASE = "https://api.geoapify.com/v1"

def _encode_polyline(coords: list) -> str:
    """Encode [(lat, lng), ...] list to Google-compatible polyline string."""
    result = []
    prev_lat = prev_lng = 0
    for lat, lng in coords:
        for cur, prev in [(round(lat * 1e5), prev_lat), (round(lng * 1e5), prev_lng)]:
            delta = cur - prev
            delta = ~(delta << 1) if delta < 0 else delta << 1
            while delta >= 0x20:
                result.append(chr((0x20 | (delta & 0x1f)) + 63))
                delta >>= 5
            result.append(chr(delta + 63))
        prev_lat, prev_lng = round(lat * 1e5), round(lng * 1e5)
    return "".join(result)

@app.get("/api/places/autocomplete")
async def places_autocomplete(input: str, current_user: User = Depends(get_current_user)):
    try:
        async with httpx.AsyncClient(timeout=8.0) as client:
            res = await client.get(
                f"{_GEO_BASE}/geocode/search",
                params={"text": input, "limit": 5, "lang": "en",
                        "filter": "countrycode:in", "apiKey": GEOAPIFY_KEY},
            )
        features = res.json().get("features", []) if res.status_code == 200 else []
        predictions = [
            {"place_id": f["properties"].get("place_id", ""),
             "description": f["properties"].get("formatted", ""),
             "lat": f["properties"].get("lat", 0.0),
             "lon": f["properties"].get("lon", 0.0)}
            for f in features
        ]
    except Exception as e:
        log.warning(f"Geoapify autocomplete failed: {e}")
        predictions = []
    return {"predictions": predictions, "status": "OK"}

@app.get("/api/places/reverse-geocode")
async def places_reverse_geocode(lat: float, lon: float, current_user: User = Depends(get_current_user)):
    try:
        async with httpx.AsyncClient(timeout=8.0) as client:
            res = await client.get(
                f"{_GEO_BASE}/geocode/reverse",
                params={"lat": lat, "lon": lon, "apiKey": GEOAPIFY_KEY},
            )
        features = res.json().get("features", []) if res.status_code == 200 else []
        if features:
            props = features[0]["properties"]
            return {
                "address": props.get("formatted", ""),
                "street": props.get("street", ""),
                "city": props.get("city", props.get("county", "")),
                "state": props.get("state", ""),
                "country": props.get("country", ""),
                "postcode": props.get("postcode", ""),
            }
    except Exception as e:
        log.warning(f"Geoapify reverse geocode failed: {e}")
    return {"address": "", "city": "", "state": "", "country": ""}

@app.get("/api/places/directions")
async def places_directions(origin: str, destination: str, current_user: User = Depends(get_current_user)):
    try:
        olat, olon = origin.split(",")
        dlat, dlon = destination.split(",")
        async with httpx.AsyncClient(timeout=10.0) as client:
            res = await client.get(
                f"{_GEO_BASE}/routing",
                params={"waypoints": f"{olat},{olon}|{dlat},{dlon}",
                        "mode": "drive", "apiKey": GEOAPIFY_KEY},
            )
        data = res.json()
        features = data.get("features", [])
        if features:
            feat = features[0]
            props = feat.get("properties", {})
            geom = feat.get("geometry", {})
            # Flatten MultiLineString or LineString coordinates (GeoJSON: [lon, lat])
            raw = geom.get("coordinates", [])
            if geom.get("type") == "MultiLineString":
                all_coords = [c for seg in raw for c in seg]
            else:
                all_coords = raw
            # Swap to (lat, lon) for polyline encoding
            latlon = [(c[1], c[0]) for c in all_coords]
            return {
                "routes": [{
                    "overview_polyline": {"points": _encode_polyline(latlon)},
                    "legs": [{"distance": {"value": int(props.get("distance", 0))},
                              "duration": {"value": int(props.get("time", 0))}}],
                }]
            }
    except Exception as e:
        log.warning(f"Geoapify routing failed: {e}")
    return {"routes": []}


class MapMatchRequest(BaseModel):
    pings: List[dict]  # [{lat, lng, time}]

@app.post("/api/places/map-match")
async def places_map_match(req: MapMatchRequest, current_user: User = Depends(get_current_user)):
    pings = req.pings
    if len(pings) < 2:
        return {"coords": []}
    # Subsample to 100 pts max (Geoapify limit)
    step = max(1, len(pings) // 100)
    sampled = pings[::step]
    if sampled[-1] is not pings[-1]:
        sampled.append(pings[-1])
    waypoints = [{"location": [p["lng"], p["lat"]]} for p in sampled]
    try:
        body = {"mode": "drive", "waypoints": waypoints}
        async with httpx.AsyncClient(timeout=10.0) as client:
            res = await client.post(
                f"{_GEO_BASE}/mapmatching",
                params={"apiKey": GEOAPIFY_KEY},
                json=body,
            )
        if res.status_code == 200:
            features = res.json().get("features", [])
            if features:
                geom = features[0].get("geometry", {})
                raw = geom.get("coordinates", [])
                if geom.get("type") == "MultiLineString":
                    raw = [c for seg in raw for c in seg]
                return {"coords": [[c[1], c[0]] for c in raw]}  # swap to [lat, lng]
    except Exception as e:
        log.warning(f"Geoapify map-match failed: {e}")
    return {"coords": []}


# ── Admin Routes ──────────────────────────────────────────────────────────────
@app.get("/api/admin/stats")
def admin_stats(admin: User = Depends(require_admin), db: Session = Depends(get_db)):
    cid = admin.company_id or "default"
    cuid = db.query(User.id).filter(User.company_id == cid)
    return {
        "total_workers": db.query(User).filter(User.role == "field_worker", User.company_id == cid).count(),
        "total_tasks": db.query(Task).filter(Task.company_id == cid).count(),
        "completed_tasks": db.query(Task).filter(Task.company_id == cid, Task.status == "completed").count(),
        "active_shifts": db.query(AttendanceLog).filter(AttendanceLog.user_id.in_(cuid), AttendanceLog.status == "active").count(),
        "pending_leaves": db.query(Leave).filter(Leave.user_id.in_(cuid), Leave.status == "pending").count(),
    }

@app.get("/api/admin/users")
def admin_list_users(admin: User = Depends(require_admin), db: Session = Depends(get_db)):
    cid = admin.company_id or "default"
    users = db.query(User).filter(User.company_id == cid).order_by(User.created_at).all()
    return [{"id": u.id, "name": u.name, "email": u.email, "role": u.role,
             "is_active": u.is_active, "photo_url": u.photo_url,
             "plain_password": u.plain_password,
             "created_at": u.created_at.isoformat() if u.created_at else None} for u in users]

class ResetPasswordRequest(BaseModel):
    new_password: str

@app.post("/api/admin/users/{user_id}/reset-password")
def admin_reset_password(user_id: str, req: ResetPasswordRequest,
                         admin: User = Depends(require_admin), db: Session = Depends(get_db)):
    cid = admin.company_id or "default"
    user = db.query(User).filter(User.id == user_id, User.company_id == cid).first()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    user.password = hash_password(req.new_password)
    user.plain_password = req.new_password
    db.commit()
    return {"ok": True}

@app.post("/api/admin/users")
def admin_create_user(req: CreateUserRequest, admin: User = Depends(require_admin), db: Session = Depends(get_db)):
    if db.query(User).filter(User.email == req.email.lower().strip()).first():
        raise HTTPException(status_code=400, detail="Email already exists")
    cid = admin.company_id or "default"
    user = User(name=req.name, email=req.email.lower().strip(),
                password=hash_password(req.password), plain_password=req.password,
                role=req.role, company_id=cid)
    db.add(user)
    db.commit()
    db.refresh(user)
    if req.role == "field_worker":
        db.add(LeaveBalance(user_id=user.id))
        # Add to the admin's company group chat room
        admin_mem = (db.query(ChatMember).join(ChatRoom)
                     .filter(ChatMember.user_id == admin.id, ChatRoom.room_type == "group")
                     .first())
        if admin_mem:
            db.add(ChatMember(room_id=admin_mem.room_id, user_id=user.id))
        db.commit()
    return {"id": user.id, "name": user.name, "email": user.email, "role": user.role}

@app.get("/api/admin/tasks")
def admin_list_tasks(admin: User = Depends(require_admin), db: Session = Depends(get_db)):
    cid = admin.company_id or "default"
    tasks = db.query(Task).filter(Task.company_id == cid).order_by(Task.created_at.desc()).all()
    return [{"id": t.id, "title": t.title, "location": t.location, "status": t.status,
             "client_name": t.client_name, "assignee_name": t.assignee.name if t.assignee else None,
             "assignee_email": t.assignee.email if t.assignee else None,
             "scheduled_time": t.scheduled_time.isoformat() if t.scheduled_time else None} for t in tasks]

@app.post("/api/admin/tasks")
async def admin_create_task(req: CreateTaskRequest, background: BackgroundTasks,
                             admin: User = Depends(require_admin), db: Session = Depends(get_db)):
    cid = admin.company_id or "default"
    assignee = None
    if req.assignee_email:
        assignee = db.query(User).filter(
            User.email == req.assignee_email.lower().strip(),
            User.company_id == cid
        ).first()
    sched = None
    if req.scheduled_time:
        try:
            sched = datetime.fromisoformat(req.scheduled_time.replace("Z", ""))
        except Exception:
            pass
    task = Task(title=req.title, description=req.description, location=req.location,
                client_name=req.client_name, assignee_id=assignee.id if assignee else None,
                latitude=req.latitude, longitude=req.longitude,
                scheduled_time=sched, status="pending", company_id=cid)
    db.add(task)
    db.commit()
    db.refresh(task)
    if assignee:
        tokens = [pt.token for pt in assignee.push_tokens]
        background.add_task(send_push, tokens, "📋 New Task Assigned",
                            f"{req.title} — {req.location or 'No location'}",
                            {"type": "task_assigned", "task_id": task.id})
    return {"id": task.id, "title": task.title, "status": task.status}

@app.post("/api/admin/bulk-tasks")
async def bulk_assign_tasks(req: BulkTaskRequest, background: BackgroundTasks,
                             admin: User = Depends(require_admin), db: Session = Depends(get_db)):
    cid = admin.company_id or "default"
    sched = None
    if req.scheduled_time:
        try:
            sched = datetime.fromisoformat(req.scheduled_time.replace("Z", ""))
        except Exception:
            pass
    created = []
    for email in req.assignee_emails:
        assignee = db.query(User).filter(
            User.email == email.lower().strip(),
            User.company_id == cid
        ).first()
        task = Task(title=req.title, description=req.description, location=req.location,
                    client_name=req.client_name,
                    assignee_id=assignee.id if assignee else None,
                    latitude=req.latitude, longitude=req.longitude,
                    scheduled_time=sched, status="pending", company_id=cid)
        db.add(task)
        if assignee:
            tokens = [pt.token for pt in assignee.push_tokens]
            background.add_task(send_push, tokens, "📋 New Task Assigned",
                                req.title, {"type": "task_assigned"})
        created.append(email)
    db.commit()
    return {"created": len(created), "assigned_to": created}

@app.get("/api/admin/attendance")
def admin_attendance(admin: User = Depends(require_admin), db: Session = Depends(get_db)):
    cid = admin.company_id or "default"
    cuid = db.query(User.id).filter(User.company_id == cid)
    logs = (db.query(AttendanceLog).filter(AttendanceLog.user_id.in_(cuid))
            .order_by(AttendanceLog.punch_in_time.desc()).limit(200).all())
    return [{"id": l.id, "user_name": l.user.name, "user_email": l.user.email,
             "punch_in_time": l.punch_in_time.isoformat() + "Z",
             "punch_out_time": l.punch_out_time.isoformat() + "Z" if l.punch_out_time else None,
             "total_hours": l.total_hours, "status": l.status,
             "check_in_note": l.check_in_note} for l in logs]

@app.get("/api/admin/performance")
def admin_performance(admin: User = Depends(require_admin), db: Session = Depends(get_db)):
    cid = admin.company_id or "default"
    workers = db.query(User).filter(User.role == "field_worker", User.company_id == cid).all()
    result = []
    for w in workers:
        logs = db.query(AttendanceLog).filter(AttendanceLog.user_id == w.id,
                                               AttendanceLog.status == "completed").all()
        total_tasks = db.query(Task).filter(Task.assignee_id == w.id).count()
        done_tasks  = db.query(Task).filter(Task.assignee_id == w.id, Task.status == "completed").count()
        total_hours = sum(l.total_hours or 0 for l in logs)
        breaches    = db.query(GPSPing).filter(GPSPing.user_id == w.id, GPSPing.is_breach == True).count()
        result.append({
            "id": w.id, "name": w.name, "email": w.email,
            "total_shifts": len(logs), "total_hours": round(total_hours, 1),
            "tasks_assigned": total_tasks, "tasks_completed": done_tasks,
            "completion_rate": round((done_tasks / total_tasks * 100) if total_tasks else 0, 1),
            "geofence_breaches": breaches,
            "avg_hours_per_shift": round(total_hours / len(logs), 1) if logs else 0,
        })
    return sorted(result, key=lambda x: x["completion_rate"], reverse=True)

@app.get("/api/admin/live-locations")
def admin_live_locations(admin: User = Depends(require_admin), db: Session = Depends(get_db)):
    cid = admin.company_id or "default"
    workers = db.query(User).filter(User.role == "field_worker", User.company_id == cid).all()
    today_start = datetime.utcnow().replace(hour=0, minute=0, second=0, microsecond=0)
    today_end = today_start + timedelta(days=1)
    result = []
    for w in workers:
        ping = (db.query(GPSPing).filter(GPSPing.user_id == w.id)
                .order_by(GPSPing.timestamp.desc()).first())
        active = db.query(AttendanceLog).filter(AttendanceLog.user_id == w.id,
                                                  AttendanceLog.status == "active").first()
        if ping:
            today_pings = (db.query(GPSPing)
                           .filter(GPSPing.user_id == w.id,
                                   GPSPing.timestamp >= today_start,
                                   GPSPing.timestamp < today_end)
                           .order_by(GPSPing.timestamp).all())
            km_today = 0.0
            for i in range(1, len(today_pings)):
                p1, p2 = today_pings[i - 1], today_pings[i]
                km_today += haversine_m(p1.latitude, p1.longitude, p2.latitude, p2.longitude) / 1000
            result.append({
                "user_id": w.id, "user_name": w.name, "user_email": w.email,
                "latitude": ping.latitude, "longitude": ping.longitude,
                "last_seen": ping.timestamp.isoformat() + "Z",
                "is_punched_in": active is not None,
                "punch_in_time": active.punch_in_time.isoformat() + "Z" if active else None,
                "km_today": round(km_today, 2),
            })
    return result

@app.get("/api/admin/user-timeline")
def user_timeline(user_id: str, date: Optional[str] = None,
                  admin: User = Depends(require_admin), db: Session = Depends(get_db)):
    today = datetime.utcnow().date()
    min_date = today - timedelta(days=90)
    if date:
        try:
            target = datetime.strptime(date, "%Y-%m-%d").date()
        except ValueError:
            raise HTTPException(400, "Use YYYY-MM-DD")
        if target < min_date:
            raise HTTPException(400, "Date must be within last 90 days")
    else:
        target = today
    day_start = datetime(target.year, target.month, target.day)
    day_end = day_start + timedelta(days=1)

    attendance = (db.query(AttendanceLog)
                  .filter(AttendanceLog.user_id == user_id,
                          AttendanceLog.punch_in_time >= day_start,
                          AttendanceLog.punch_in_time < day_end)
                  .order_by(AttendanceLog.punch_in_time).first())

    pings = (db.query(GPSPing)
             .filter(GPSPing.user_id == user_id,
                     GPSPing.timestamp >= day_start,
                     GPSPing.timestamp < day_end)
             .order_by(GPSPing.timestamp).all())

    def hav(lat1, lon1, lat2, lon2):
        phi1, phi2 = math.radians(lat1), math.radians(lat2)
        a = (math.sin(math.radians(lat2-lat1)/2)**2 +
             math.cos(phi1)*math.cos(phi2)*math.sin(math.radians(lon2-lon1)/2)**2)
        return 2*6371000*math.asin(math.sqrt(a))

    events = []
    if attendance:
        events.append({"type":"punch_in","time":attendance.punch_in_time.isoformat()+"Z",
                        "label":"Punch In","duration_min":0,"distance_km":0,
                        "lat":attendance.latitude,"lng":attendance.longitude})

    if len(pings) >= 2:
        seg_pings, seg_type, segments = [pings[0]], None, []
        for i in range(1, len(pings)):
            d = hav(pings[i-1].latitude, pings[i-1].longitude, pings[i].latitude, pings[i].longitude)
            ntype = "travel" if d > 30 else "halt"
            if seg_type is None: seg_type = ntype
            if ntype != seg_type and len(seg_pings) >= 2:
                segments.append({"type":seg_type,"pings":seg_pings})
                seg_pings, seg_type = [pings[i-1], pings[i]], ntype
            else:
                seg_pings.append(pings[i])
        if seg_pings: segments.append({"type":seg_type or "halt","pings":seg_pings})
        for seg in segments:
            ps = seg["pings"]
            if not ps: continue
            dur = int((ps[-1].timestamp - ps[0].timestamp).total_seconds()/60)
            dist = sum(hav(ps[j-1].latitude,ps[j-1].longitude,ps[j].latitude,ps[j].longitude) for j in range(1,len(ps)))
            mid = ps[len(ps)//2]
            events.append({"type":seg["type"],"time":ps[0].timestamp.isoformat()+"Z",
                            "end_time":ps[-1].timestamp.isoformat()+"Z",
                            "duration_min":dur,"distance_km":round(dist/1000,2),
                            "lat":mid.latitude,"lng":mid.longitude,
                            "label":"Travel" if seg["type"]=="travel" else "Halt"})

    if attendance and attendance.punch_out_time:
        events.append({"type":"punch_out","time":attendance.punch_out_time.isoformat()+"Z",
                        "label":"Punch Out","duration_min":0,"distance_km":0,
                        "lat":attendance.latitude,"lng":attendance.longitude})

    events.sort(key=lambda e: e["time"])

    total_gps_km = (sum(hav(pings[i-1].latitude,pings[i-1].longitude,pings[i].latitude,pings[i].longitude)
                       for i in range(1,len(pings)))/1000) if len(pings)>1 else 0
    tracked_h = 0
    if attendance:
        end = attendance.punch_out_time or datetime.utcnow()
        tracked_h = (end - attendance.punch_in_time).total_seconds()/3600

    return {"events":events,
            "pings":[{"lat":p.latitude,"lng":p.longitude,"time":p.timestamp.isoformat()+"Z"} for p in pings],
            "stats":{"attendance_status":attendance.status if attendance else "absent",
                     "attendance_hours":round(attendance.total_hours or 0,2) if attendance else 0,
                     "tracked_hours":round(tracked_h,2),
                     "gps_distance_km":round(total_gps_km,2),
                     "activities":len([e for e in events if e["type"] in ["travel","halt"]]),
                     "punch_in":attendance.punch_in_time.isoformat()+"Z" if attendance else None,
                     "punch_out":attendance.punch_out_time.isoformat()+"Z" if attendance and attendance.punch_out_time else None},
            "date":target.isoformat(),"user_id":user_id}


@app.get("/api/gps/my-trail")
def my_trail(current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    today_start = datetime.utcnow().replace(hour=0, minute=0, second=0, microsecond=0)
    today_end = today_start + timedelta(days=1)

    attendance = (db.query(AttendanceLog)
                  .filter(AttendanceLog.user_id == current_user.id,
                          AttendanceLog.punch_in_time >= today_start,
                          AttendanceLog.punch_in_time < today_end)
                  .order_by(AttendanceLog.punch_in_time).first())

    pings = (db.query(GPSPing)
             .filter(GPSPing.user_id == current_user.id,
                     GPSPing.timestamp >= today_start,
                     GPSPing.timestamp < today_end)
             .order_by(GPSPing.timestamp).all())

    def hav(lat1, lon1, lat2, lon2):
        phi1, phi2 = math.radians(lat1), math.radians(lat2)
        a = (math.sin(math.radians(lat2-lat1)/2)**2 +
             math.cos(phi1)*math.cos(phi2)*math.sin(math.radians(lon2-lon1)/2)**2)
        return 2*6371000*math.asin(math.sqrt(a))

    events = []
    if attendance:
        events.append({"type":"punch_in","time":attendance.punch_in_time.isoformat()+"Z",
                        "label":"Punch In","duration_min":0,"distance_km":0,
                        "lat":attendance.latitude,"lng":attendance.longitude})

    if len(pings) >= 2:
        seg_pings, seg_type, segments = [pings[0]], None, []
        for i in range(1, len(pings)):
            d = hav(pings[i-1].latitude, pings[i-1].longitude, pings[i].latitude, pings[i].longitude)
            ntype = "travel" if d > 30 else "halt"
            if seg_type is None: seg_type = ntype
            if ntype != seg_type and len(seg_pings) >= 2:
                segments.append({"type": seg_type, "pings": seg_pings})
                seg_pings, seg_type = [pings[i-1], pings[i]], ntype
            else:
                seg_pings.append(pings[i])
        if seg_pings: segments.append({"type": seg_type or "halt", "pings": seg_pings})
        for seg in segments:
            ps = seg["pings"]
            if not ps: continue
            dur = int((ps[-1].timestamp - ps[0].timestamp).total_seconds() / 60)
            dist = sum(hav(ps[j-1].latitude,ps[j-1].longitude,ps[j].latitude,ps[j].longitude) for j in range(1,len(ps)))
            mid = ps[len(ps)//2]
            events.append({"type": seg["type"], "time": ps[0].timestamp.isoformat()+"Z",
                            "end_time": ps[-1].timestamp.isoformat()+"Z",
                            "duration_min": dur, "distance_km": round(dist/1000, 2),
                            "lat": mid.latitude, "lng": mid.longitude,
                            "label": "Travel" if seg["type"] == "travel" else "Halt"})

    if attendance and attendance.punch_out_time:
        events.append({"type":"punch_out","time":attendance.punch_out_time.isoformat()+"Z",
                        "label":"Punch Out","duration_min":0,"distance_km":0,
                        "lat":attendance.latitude,"lng":attendance.longitude})

    events.sort(key=lambda e: e["time"])
    total_km = (sum(hav(pings[i-1].latitude,pings[i-1].longitude,pings[i].latitude,pings[i].longitude)
                    for i in range(1,len(pings)))/1000) if len(pings)>1 else 0

    return {
        "pings": [{"lat": p.latitude, "lng": p.longitude, "time": p.timestamp.isoformat()+"Z"} for p in pings],
        "events": events,
        "stats": {
            "gps_distance_km": round(total_km, 2),
            "total_pings": len(pings),
            "punch_in": attendance.punch_in_time.isoformat()+"Z" if attendance else None,
            "punch_out": attendance.punch_out_time.isoformat()+"Z" if attendance and attendance.punch_out_time else None,
        }
    }

@app.get("/api/admin/daily-hours")
def daily_hours(days: int = 30, admin: User = Depends(require_admin), db: Session = Depends(get_db)):
    from collections import defaultdict
    cid = admin.company_id or "default"
    cuid = db.query(User.id).filter(User.company_id == cid)
    end_date = datetime.utcnow().date()
    start_date = end_date - timedelta(days=days-1)
    day_start_dt = datetime(start_date.year, start_date.month, start_date.day)
    day_end_dt = datetime(end_date.year, end_date.month, end_date.day) + timedelta(days=1)
    logs = (db.query(AttendanceLog)
            .filter(AttendanceLog.user_id.in_(cuid),
                    AttendanceLog.punch_in_time >= day_start_dt,
                    AttendanceLog.punch_in_time < day_end_dt,
                    AttendanceLog.total_hours.isnot(None)).all())
    daily = defaultdict(list)
    for log in logs:
        if log.total_hours:
            daily[log.punch_in_time.date().isoformat()].append(log.total_hours)
    return [{"date":(start_date+timedelta(days=i)).isoformat(),
             "avg_hours":round(sum(daily.get((start_date+timedelta(days=i)).isoformat(),[]))/
                               max(len(daily.get((start_date+timedelta(days=i)).isoformat(),[])),1),1),
             "workers":len(daily.get((start_date+timedelta(days=i)).isoformat(),[]))}
            for i in range(days)]


@app.get("/api/admin/geofence-alerts")
def geofence_alerts(admin: User = Depends(require_admin), db: Session = Depends(get_db)):
    cid = admin.company_id or "default"
    cuid = db.query(User.id).filter(User.company_id == cid)
    breaches = (db.query(GPSPing).filter(GPSPing.is_breach == True, GPSPing.user_id.in_(cuid))
                .order_by(GPSPing.created_at.desc()).limit(100).all())
    return [{"id": b.id, "user_name": b.user.name, "user_email": b.user.email,
             "latitude": b.latitude, "longitude": b.longitude,
             "timestamp": b.created_at.isoformat() + "Z",
             "task_id": b.task_id} for b in breaches]

@app.get("/api/admin/leaves")
def admin_leaves(admin: User = Depends(require_admin), db: Session = Depends(get_db)):
    cid = admin.company_id or "default"
    cuid = db.query(User.id).filter(User.company_id == cid)
    leaves = db.query(Leave).filter(Leave.user_id.in_(cuid)).order_by(Leave.created_at.desc()).all()
    return [{"id": l.id, "user_name": l.user.name, "user_email": l.user.email,
             "leave_type": l.leave_type, "start_date": l.start_date.date().isoformat(),
             "end_date": l.end_date.date().isoformat(), "days": l.days,
             "reason": l.reason, "status": l.status,
             "created_at": l.created_at.isoformat()} for l in leaves]

@app.put("/api/admin/leaves/{leave_id}")
def admin_leave_action(leave_id: str, req: LeaveActionRequest,
                       admin: User = Depends(require_admin), db: Session = Depends(get_db)):
    cid = admin.company_id or "default"
    cuid = db.query(User.id).filter(User.company_id == cid)
    leave = db.query(Leave).filter(Leave.id == leave_id, Leave.user_id.in_(cuid)).first()
    if not leave:
        raise HTTPException(status_code=404, detail="Leave not found")
    leave.status = req.status
    if req.status == "approved":
        bal = db.query(LeaveBalance).filter(LeaveBalance.user_id == leave.user_id).first()
        if bal:
            if leave.leave_type == "sick":
                bal.sick_days = max(0, bal.sick_days - leave.days)
            elif leave.leave_type == "casual":
                bal.casual_days = max(0, bal.casual_days - leave.days)
            elif leave.leave_type == "annual":
                bal.annual_days = max(0, bal.annual_days - leave.days)
    db.commit()
    return {"status": leave.status}

@app.get("/api/admin/reports/attendance-csv")
def attendance_csv(admin: User = Depends(require_admin), db: Session = Depends(get_db)):
    cid = admin.company_id or "default"
    cuid = db.query(User.id).filter(User.company_id == cid)
    logs = (db.query(AttendanceLog).filter(AttendanceLog.user_id.in_(cuid))
            .order_by(AttendanceLog.punch_in_time.desc()).all())
    lines = ["Name,Email,Punch In,Punch Out,Hours,Status,Note"]
    for l in logs:
        pin = l.punch_in_time.strftime("%Y-%m-%d %H:%M")
        pout = l.punch_out_time.strftime("%Y-%m-%d %H:%M") if l.punch_out_time else ""
        note = (l.check_in_note or "").replace(",", ";")
        lines.append(f"{l.user.name},{l.user.email},{pin},{pout},{l.total_hours or ''},{l.status},{note}")
    content = "\n".join(lines)
    return StreamingResponse(io.StringIO(content), media_type="text/csv",
                             headers={"Content-Disposition": "attachment; filename=attendance.csv"})

@app.get("/api/admin/reports/payroll-csv")
def payroll_csv(admin: User = Depends(require_admin), db: Session = Depends(get_db)):
    rate_per_hour = 200  # ₹200/hour default
    cid = admin.company_id or "default"
    now = datetime.utcnow()
    month_start = now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    workers = db.query(User).filter(User.role == "field_worker", User.company_id == cid).all()
    lines = ["Name,Email,Shifts,Total Hours,Rate/Hr (INR),Gross Pay (INR)"]
    for w in workers:
        logs = db.query(AttendanceLog).filter(AttendanceLog.user_id == w.id,
                                               AttendanceLog.punch_in_time >= month_start,
                                               AttendanceLog.status == "completed").all()
        total_hours = round(sum(l.total_hours or 0 for l in logs), 2)
        gross = round(total_hours * rate_per_hour, 2)
        lines.append(f"{w.name},{w.email},{len(logs)},{total_hours},{rate_per_hour},{gross}")
    content = "\n".join(lines)
    return StreamingResponse(io.StringIO(content), media_type="text/csv",
                             headers={"Content-Disposition": "attachment; filename=payroll.csv"})

@app.post("/api/chat/direct/{target_user_id}")
def get_or_create_direct(target_user_id: str,
                          current_user: User = Depends(get_current_user),
                          db: Session = Depends(get_db)):
    target = db.query(User).filter(User.id == target_user_id, User.is_active == True).first()
    if not target:
        raise HTTPException(status_code=404, detail="User not found")
    my_rooms = {m.room_id for m in db.query(ChatMember).filter(ChatMember.user_id == current_user.id).all()}
    their_rooms = {m.room_id for m in db.query(ChatMember).filter(ChatMember.user_id == target_user_id).all()}
    for room_id in (my_rooms & their_rooms):
        room = db.query(ChatRoom).filter(ChatRoom.id == room_id, ChatRoom.room_type == "direct").first()
        if room:
            return {"id": room.id, "name": target.name, "room_type": "direct"}
    room = ChatRoom(name=f"{current_user.name} & {target.name}", room_type="direct")
    db.add(room)
    db.commit()
    db.refresh(room)
    db.add(ChatMember(room_id=room.id, user_id=current_user.id))
    db.add(ChatMember(room_id=room.id, user_id=target_user_id))
    db.commit()
    return {"id": room.id, "name": target.name, "room_type": "direct"}

@app.get("/api/users/list")
def list_users_for_chat(current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    cid = current_user.company_id or "default"
    users = db.query(User).filter(User.id != current_user.id, User.is_active == True, User.company_id == cid).all()
    return [{"id": u.id, "name": u.name, "role": u.role, "photo_url": u.photo_url} for u in users]

@app.get("/api/admin/chat/rooms")
def admin_chat_rooms(admin: User = Depends(require_admin), db: Session = Depends(get_db)):
    return get_rooms(admin, db)

@app.get("/api/admin/chat/messages/{room_id}")
def admin_chat_messages(room_id: str, admin: User = Depends(require_admin), db: Session = Depends(get_db)):
    msgs = (db.query(Message).filter(Message.room_id == room_id)
            .order_by(Message.created_at.desc()).limit(100).all())
    return [{"id": m.id, "content": m.content, "sender_name": m.sender.name,
             "created_at": m.created_at.isoformat() + "Z",
             "is_me": m.sender_id == admin.id} for m in reversed(msgs)]

@app.post("/api/admin/chat/messages/{room_id}")
async def admin_send_message(room_id: str, req: SendMessageRequest, background: BackgroundTasks,
                              admin: User = Depends(require_admin), db: Session = Depends(get_db)):
    member = db.query(ChatMember).filter(ChatMember.room_id == room_id,
                                          ChatMember.user_id == admin.id).first()
    if not member:
        db.add(ChatMember(room_id=room_id, user_id=admin.id))
        db.commit()
    msg = Message(room_id=room_id, sender_id=admin.id, content=req.content.strip())
    db.add(msg)
    db.commit()
    db.refresh(msg)
    other_members = db.query(ChatMember).filter(ChatMember.room_id == room_id,
                                                  ChatMember.user_id != admin.id).all()
    tokens = [pt.token for om in other_members for pt in om.user.push_tokens]
    background.add_task(send_push, tokens, f"💬 {admin.name}", req.content[:100],
                        {"type": "chat", "room_id": room_id})
    return {"id": msg.id, "content": msg.content, "sender_name": admin.name,
            "created_at": msg.created_at.isoformat() + "Z"}


# ── Clients ───────────────────────────────────────────────────────────────────
def _client_dict(c: Client):
    return {"id": c.id, "name": c.name, "client_id": c.client_id, "visibility": c.visibility,
            "contact_name": c.contact_name, "contact_code": c.contact_code,
            "contact_number": c.contact_number, "latitude": c.latitude, "longitude": c.longitude,
            "address_line1": c.address_line1, "address_line2": c.address_line2,
            "city": c.city, "district": c.district, "state": c.state, "country": c.country,
            "pin_code": c.pin_code, "radius": c.radius, "employee_override": c.employee_override,
            "description": c.description, "email": c.email, "category": c.category,
            "created_at": c.created_at.isoformat() if c.created_at else None}

@app.get("/api/admin/clients")
def admin_list_clients(admin: User = Depends(require_admin), db: Session = Depends(get_db)):
    cid = admin.company_id or "default"
    return [_client_dict(c) for c in db.query(Client).filter(Client.company_id == cid).order_by(Client.created_at).all()]

@app.post("/api/admin/clients")
def admin_create_client(req: CreateClientRequest, admin: User = Depends(require_admin), db: Session = Depends(get_db)):
    cid = admin.company_id or "default"
    c = Client(**req.dict(), company_id=cid)
    db.add(c); db.commit(); db.refresh(c)
    return _client_dict(c)

@app.delete("/api/admin/clients/{client_id}")
def admin_delete_client(client_id: str, admin: User = Depends(require_admin), db: Session = Depends(get_db)):
    cid = admin.company_id or "default"
    c = db.query(Client).filter(Client.id == client_id, Client.company_id == cid).first()
    if not c:
        raise HTTPException(status_code=404, detail="Client not found")
    db.delete(c); db.commit()
    return {"ok": True}


# ── Sites ─────────────────────────────────────────────────────────────────────
def _site_dict(s: Site):
    return {"id": s.id, "name": s.name, "email": s.email, "site_id": s.site_id,
            "contact_name": s.contact_name, "contact_code": s.contact_code,
            "contact_number": s.contact_number, "description": s.description,
            "site_type": s.site_type, "latitude": s.latitude, "longitude": s.longitude,
            "address": s.address, "radius": s.radius, "city": s.city, "pin_code": s.pin_code,
            "client_id": s.client_id,
            "created_at": s.created_at.isoformat() if s.created_at else None}

@app.get("/api/admin/sites")
def admin_list_sites(admin: User = Depends(require_admin), db: Session = Depends(get_db)):
    cid = admin.company_id or "default"
    return [_site_dict(s) for s in db.query(Site).filter(Site.company_id == cid).order_by(Site.created_at).all()]

@app.post("/api/admin/sites")
def admin_create_site(req: CreateSiteRequest, admin: User = Depends(require_admin), db: Session = Depends(get_db)):
    cid = admin.company_id or "default"
    s = Site(**req.dict(), company_id=cid)
    db.add(s); db.commit(); db.refresh(s)
    return _site_dict(s)

@app.delete("/api/admin/sites/{site_id}")
def admin_delete_site(site_id: str, admin: User = Depends(require_admin), db: Session = Depends(get_db)):
    cid = admin.company_id or "default"
    s = db.query(Site).filter(Site.id == site_id, Site.company_id == cid).first()
    if not s:
        raise HTTPException(status_code=404, detail="Site not found")
    db.delete(s); db.commit()
    return {"ok": True}

@app.delete("/api/admin/clear-test-data")
def admin_clear_test_data(admin: User = Depends(require_admin), db: Session = Depends(get_db)):
    """Wipes attendance logs, GPS pings, tasks, and leaves for this company only."""
    cid = admin.company_id or "default"
    cuid = db.query(User.id).filter(User.company_id == cid)
    counts = {}
    n = db.query(AttendanceLog).filter(AttendanceLog.user_id.in_(cuid)).delete(synchronize_session=False)
    counts["attendance_logs"] = n
    n = db.query(GPSPing).filter(GPSPing.user_id.in_(cuid)).delete(synchronize_session=False)
    counts["gps_pings"] = n
    n = db.query(Task).filter(Task.company_id == cid).delete(synchronize_session=False)
    counts["tasks"] = n
    n = db.query(Leave).filter(Leave.user_id.in_(cuid)).delete(synchronize_session=False)
    counts["leaves"] = n
    db.commit()
    return {"ok": True, "deleted": counts}

@app.delete("/api/admin/full-reset")
def admin_full_reset(admin: User = Depends(require_admin), db: Session = Depends(get_db)):
    """Nuclear reset: deletes all field workers + all operational data for this company only."""
    cid = admin.company_id or "default"
    cuid = db.query(User.id).filter(User.company_id == cid)
    # Delete operational data for company users (foreign key order)
    worker_ids = [r[0] for r in db.query(User.id).filter(User.company_id == cid, User.role != "admin").all()]
    if worker_ids:
        for room_mem in db.query(ChatMember).filter(ChatMember.user_id.in_(worker_ids)).all():
            db.delete(room_mem)
        db.query(GPSPing).filter(GPSPing.user_id.in_(worker_ids)).delete(synchronize_session=False)
        db.query(AttendanceLog).filter(AttendanceLog.user_id.in_(worker_ids)).delete(synchronize_session=False)
        db.query(LeaveBalance).filter(LeaveBalance.user_id.in_(worker_ids)).delete(synchronize_session=False)
        db.query(Leave).filter(Leave.user_id.in_(worker_ids)).delete(synchronize_session=False)
        db.query(PushToken).filter(PushToken.user_id.in_(worker_ids)).delete(synchronize_session=False)
        db.query(RefreshToken).filter(RefreshToken.user_id.in_(worker_ids)).delete(synchronize_session=False)
    db.query(Task).filter(Task.company_id == cid).delete(synchronize_session=False)
    deleted_users = db.query(User).filter(User.company_id == cid, User.role != "admin").delete(synchronize_session=False)
    db.commit()
    return {"ok": True, "deleted_users": deleted_users}

@app.post("/api/attendance/auto-punch-out")
def auto_punch_out(current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    """Punch out the current user's active log without requiring selfie/location.
    Called automatically on sign-out so admin panel reflects the punch-out."""
    active = db.query(AttendanceLog).filter(
        AttendanceLog.user_id == current_user.id,
        AttendanceLog.punch_out_time == None,
        AttendanceLog.status == "active"
    ).first()
    if not active:
        return {"ok": True, "message": "Not punched in"}
    now = datetime.utcnow()
    active.punch_out_time = now
    active.total_hours = round((now - active.punch_in_time).total_seconds() / 3600, 2)
    active.status = "completed"
    db.commit()
    return {"ok": True, "closed_log_id": active.id}

@app.post("/api/admin/force-punch-out/{user_id}")
def admin_force_punch_out(user_id: str, admin: User = Depends(require_admin), db: Session = Depends(get_db)):
    """Force-close any open attendance log for a user without requiring selfie/location."""
    cid = admin.company_id or "default"
    target = db.query(User).filter(User.id == user_id, User.company_id == cid).first()
    if not target:
        raise HTTPException(status_code=404, detail="User not found")
    active = db.query(AttendanceLog).filter(
        AttendanceLog.user_id == user_id,
        AttendanceLog.punch_out_time == None,
        AttendanceLog.status == "active"
    ).first()
    if not active:
        return {"ok": True, "message": "No active punch found"}
    now = datetime.utcnow()
    active.punch_out_time = now
    active.total_hours = round((now - active.punch_in_time).total_seconds() / 3600, 2)
    active.status = "completed"
    db.commit()
    return {"ok": True, "closed_log_id": active.id}


# ── Payroll ───────────────────────────────────────────────────────────────────

class SalaryConfigUpdate(BaseModel):
    base_salary: Optional[float] = None
    working_days_per_month: Optional[int] = None
    shift_start: Optional[str] = None
    shift_end: Optional[str] = None
    overtime_rate_per_hour: Optional[float] = None
    allowances: Optional[float] = None
    deductions: Optional[float] = None
    allowance_note: Optional[str] = None
    deduction_note: Optional[str] = None

@app.get("/api/admin/payroll/config")
def get_all_salary_configs(admin: User = Depends(require_admin), db: Session = Depends(get_db)):
    cid = admin.company_id or "default"
    workers = db.query(User).filter(User.company_id == cid, User.role == "field_worker", User.is_active == True).all()
    result = []
    for w in workers:
        cfg = db.query(SalaryConfig).filter(SalaryConfig.user_id == w.id).first()
        result.append({
            "user_id": w.id, "name": w.name, "email": w.email,
            "base_salary": cfg.base_salary if cfg else 0.0,
            "working_days_per_month": cfg.working_days_per_month if cfg else 26,
            "shift_start": cfg.shift_start if cfg else "09:00",
            "shift_end": cfg.shift_end if cfg else "18:00",
            "overtime_rate_per_hour": cfg.overtime_rate_per_hour if cfg else 0.0,
            "allowances": cfg.allowances if cfg else 0.0,
            "deductions": cfg.deductions if cfg else 0.0,
            "allowance_note": cfg.allowance_note if cfg else "",
            "deduction_note": cfg.deduction_note if cfg else "",
        })
    return result

@app.put("/api/admin/payroll/config/{user_id}")
def update_salary_config(user_id: str, req: SalaryConfigUpdate, admin: User = Depends(require_admin), db: Session = Depends(get_db)):
    cid = admin.company_id or "default"
    target = db.query(User).filter(User.id == user_id, User.company_id == cid).first()
    if not target:
        raise HTTPException(status_code=404, detail="User not found")
    cfg = db.query(SalaryConfig).filter(SalaryConfig.user_id == user_id).first()
    if not cfg:
        cfg = SalaryConfig(user_id=user_id, company_id=cid)
        db.add(cfg)
    for field, val in req.model_dump(exclude_none=True).items():
        setattr(cfg, field, val)
    db.commit()
    return {"ok": True}

@app.get("/api/admin/payroll/calculate")
def calculate_payroll(month: str, admin: User = Depends(require_admin), db: Session = Depends(get_db)):
    """month = YYYY-MM"""
    cid = admin.company_id or "default"
    try:
        year, mon = int(month.split("-")[0]), int(month.split("-")[1])
    except Exception:
        raise HTTPException(status_code=400, detail="month must be YYYY-MM")

    import calendar
    month_start = datetime(year, mon, 1)
    last_day = calendar.monthrange(year, mon)[1]
    month_end = datetime(year, mon, last_day, 23, 59, 59)

    workers = db.query(User).filter(User.company_id == cid, User.role == "field_worker", User.is_active == True).all()
    result = []
    for w in workers:
        cfg = db.query(SalaryConfig).filter(SalaryConfig.user_id == w.id).first()
        base = cfg.base_salary if cfg else 0.0
        work_days = cfg.working_days_per_month if cfg else 26
        shift_end_str = cfg.shift_end if cfg else "18:00"
        ot_rate = cfg.overtime_rate_per_hour if cfg else 0.0
        allowances = cfg.allowances if cfg else 0.0
        deductions = cfg.deductions if cfg else 0.0

        logs = db.query(AttendanceLog).filter(
            AttendanceLog.user_id == w.id,
            AttendanceLog.punch_in_time >= month_start,
            AttendanceLog.punch_in_time <= month_end,
            AttendanceLog.punch_out_time != None
        ).all()

        present_days = len(set(l.punch_in_time.date() for l in logs))
        absent_days = max(0, work_days - present_days)

        ot_hours = 0.0
        try:
            se_h, se_m = map(int, shift_end_str.split(":"))
            for l in logs:
                if l.punch_out_time:
                    shift_end_dt = l.punch_in_time.replace(hour=se_h, minute=se_m, second=0, microsecond=0)
                    if l.punch_out_time > shift_end_dt:
                        ot_hours += (l.punch_out_time - shift_end_dt).total_seconds() / 3600
        except Exception:
            pass

        per_day = base / work_days if work_days > 0 else 0
        earned = round(per_day * present_days, 2)
        ot_pay = round(ot_hours * ot_rate, 2)
        net_pay = round(earned + ot_pay + allowances - deductions, 2)

        result.append({
            "user_id": w.id, "name": w.name,
            "present_days": present_days, "absent_days": absent_days,
            "ot_hours": round(ot_hours, 2), "ot_pay": ot_pay,
            "base_salary": base, "earned": earned,
            "allowances": allowances, "allowance_note": cfg.allowance_note if cfg else "",
            "deductions": deductions, "deduction_note": cfg.deduction_note if cfg else "",
            "net_pay": net_pay,
        })
    return result

@app.get("/api/admin/payroll/slip/{user_id}")
def download_salary_slip(user_id: str, month: str, admin: User = Depends(require_admin), db: Session = Depends(get_db)):
    """Generate PDF salary slip for one worker. month = YYYY-MM"""
    from fpdf import FPDF
    import calendar

    cid = admin.company_id or "default"
    worker = db.query(User).filter(User.id == user_id, User.company_id == cid).first()
    if not worker:
        raise HTTPException(status_code=404, detail="User not found")

    try:
        year, mon = int(month.split("-")[0]), int(month.split("-")[1])
    except Exception:
        raise HTTPException(status_code=400, detail="month must be YYYY-MM")

    month_start = datetime(year, mon, 1)
    last_day = calendar.monthrange(year, mon)[1]
    month_end = datetime(year, mon, last_day, 23, 59, 59)

    cfg = db.query(SalaryConfig).filter(SalaryConfig.user_id == user_id).first()
    base = cfg.base_salary if cfg else 0.0
    work_days = cfg.working_days_per_month if cfg else 26
    shift_end_str = cfg.shift_end if cfg else "18:00"
    ot_rate = cfg.overtime_rate_per_hour if cfg else 0.0
    allowances = cfg.allowances if cfg else 0.0
    deductions = cfg.deductions if cfg else 0.0

    logs = db.query(AttendanceLog).filter(
        AttendanceLog.user_id == user_id,
        AttendanceLog.punch_in_time >= month_start,
        AttendanceLog.punch_in_time <= month_end,
        AttendanceLog.punch_out_time != None
    ).all()

    present_days = len(set(l.punch_in_time.date() for l in logs))
    absent_days = max(0, work_days - present_days)

    ot_hours = 0.0
    try:
        se_h, se_m = map(int, shift_end_str.split(":"))
        for l in logs:
            if l.punch_out_time:
                shift_end_dt = l.punch_in_time.replace(hour=se_h, minute=se_m, second=0, microsecond=0)
                if l.punch_out_time > shift_end_dt:
                    ot_hours += (l.punch_out_time - shift_end_dt).total_seconds() / 3600
    except Exception:
        pass

    per_day = base / work_days if work_days > 0 else 0
    earned = round(per_day * present_days, 2)
    ot_pay = round(ot_hours * ot_rate, 2)
    net_pay = round(earned + ot_pay + allowances - deductions, 2)
    month_label = datetime(year, mon, 1).strftime("%B %Y")

    pdf = FPDF()
    pdf.add_page()
    pdf.set_margins(20, 20, 20)

    # Header
    pdf.set_fill_color(26, 110, 242)
    pdf.rect(0, 0, 210, 32, "F")
    pdf.set_text_color(255, 255, 255)
    pdf.set_font("Helvetica", "B", 20)
    pdf.set_xy(20, 8)
    pdf.cell(0, 10, "FieldPulse", ln=False)
    pdf.set_font("Helvetica", "", 11)
    pdf.set_xy(20, 20)
    pdf.cell(0, 7, f"Salary Slip - {month_label}")

    pdf.set_text_color(30, 30, 30)
    pdf.set_xy(20, 38)

    # Worker info
    pdf.set_font("Helvetica", "B", 13)
    pdf.cell(0, 8, worker.name, ln=True)
    pdf.set_font("Helvetica", "", 10)
    pdf.set_text_color(100, 100, 100)
    pdf.cell(0, 6, worker.email, ln=True)
    pdf.ln(4)

    # Divider
    pdf.set_draw_color(220, 220, 220)
    pdf.set_line_width(0.4)
    pdf.line(20, pdf.get_y(), 190, pdf.get_y())
    pdf.ln(5)

    def row(label, value, bold=False):
        pdf.set_text_color(80, 80, 80)
        pdf.set_font("Helvetica", "", 10)
        pdf.cell(110, 8, label)
        pdf.set_text_color(30, 30, 30)
        pdf.set_font("Helvetica", "B" if bold else "", 10)
        pdf.cell(0, 8, str(value), ln=True)

    # Attendance
    pdf.set_font("Helvetica", "B", 11)
    pdf.set_text_color(26, 110, 242)
    pdf.cell(0, 8, "Attendance", ln=True)
    pdf.set_text_color(30, 30, 30)
    row("Working Days (Month)", work_days)
    row("Present Days", present_days)
    row("Absent Days", absent_days)
    row("Overtime Hours", f"{ot_hours:.2f} hrs")
    pdf.ln(3)

    # Earnings
    pdf.set_font("Helvetica", "B", 11)
    pdf.set_text_color(26, 110, 242)
    pdf.cell(0, 8, "Earnings", ln=True)
    pdf.set_text_color(30, 30, 30)
    row("Base Salary", f"Rs {base:,.2f}")
    row("Earned (for present days)", f"Rs {earned:,.2f}")
    row("Overtime Pay", f"Rs {ot_pay:,.2f}")
    allow_label = f"Allowances ({cfg.allowance_note})" if cfg and cfg.allowance_note else "Allowances"
    row(allow_label, f"Rs {allowances:,.2f}")
    pdf.ln(3)

    # Deductions
    pdf.set_font("Helvetica", "B", 11)
    pdf.set_text_color(220, 60, 60)
    pdf.cell(0, 8, "Deductions", ln=True)
    pdf.set_text_color(30, 30, 30)
    ded_label = f"Deductions ({cfg.deduction_note})" if cfg and cfg.deduction_note else "Deductions"
    row(ded_label, f"Rs {deductions:,.2f}")
    pdf.ln(3)

    # Net Pay box
    pdf.set_fill_color(240, 247, 255)
    pdf.set_draw_color(26, 110, 242)
    pdf.set_line_width(0.6)
    y = pdf.get_y()
    pdf.rect(20, y, 170, 16, "FD")
    pdf.set_xy(25, y + 3)
    pdf.set_font("Helvetica", "B", 13)
    pdf.set_text_color(26, 110, 242)
    pdf.cell(110, 10, "NET PAY")
    pdf.set_font("Helvetica", "B", 14)
    pdf.cell(0, 10, f"Rs {net_pay:,.2f}")
    pdf.ln(22)

    # Footer
    pdf.set_text_color(150, 150, 150)
    pdf.set_font("Helvetica", "I", 8)
    pdf.cell(0, 6, f"Generated on {datetime.utcnow().strftime('%d %b %Y')} - FieldPulse Payroll System", align="C")

    buf = io.BytesIO(pdf.output())
    filename = f"salary_slip_{worker.name.replace(' ','_')}_{month}.pdf"
    return StreamingResponse(buf, media_type="application/pdf",
                             headers={"Content-Disposition": f'attachment; filename="{filename}"'})
