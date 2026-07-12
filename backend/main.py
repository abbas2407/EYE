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
from models import (User, RefreshToken, AttendanceLog, Task, UploadedFile,
                    LeaveBalance, Leave, ChatRoom, ChatMember, Message, GPSPing, PushToken)
from auth import hash_password, verify_password, create_access_token, create_refresh_token, decode_token
from seed import seed

logging.basicConfig(level=logging.INFO)
log = logging.getLogger(__name__)

Base.metadata.create_all(bind=engine)
seed()

UPLOAD_DIR = Path(os.getenv("UPLOAD_DIR", "/app/data/uploads"))
UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
BASE_URL = os.getenv("BASE_URL", "http://167.233.90.245:8000")
GOOGLE_MAPS_API_KEY = "AIzaSyAJHF-B2ulEDrxStgKH4NS7szhFdjErnos"

app = FastAPI(title="FieldPulse API", version="2.0.0")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_credentials=True,
                   allow_methods=["*"], allow_headers=["*"])
app.mount("/uploads", StaticFiles(directory=str(UPLOAD_DIR)), name="uploads")


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

def get_admin_tokens(db: Session) -> list:
    admins = db.query(User).filter(User.role.in_(["admin", "manager"])).all()
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


# ── Health ────────────────────────────────────────────────────────────────────
@app.get("/")
def root():
    return {"status": "ok", "service": "FieldPulse API", "version": "2.0.0"}

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

    admin_tokens = get_admin_tokens(db)
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

    admin_tokens = get_admin_tokens(db)
    background.add_task(send_push, admin_tokens, "🔴 Punch Out",
                        f"{current_user.name} punched out — {total_hours:.1f}h worked",
                        {"type": "punch_out", "user_id": current_user.id})
    return {"id": entry.id, "punch_out_time": now.isoformat() + "Z",
            "total_hours": total_hours, "message": "Punched out"}

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
    logs = db.query(AttendanceLog).filter(AttendanceLog.user_id == current_user.id,
                                           AttendanceLog.punch_in_time >= today_start,
                                           AttendanceLog.punch_in_time < today_end).all()
    tasks = db.query(Task).filter(Task.assignee_id == current_user.id,
                                   Task.scheduled_time >= today_start,
                                   Task.scheduled_time < today_end).all()
    active_log = next((l for l in logs if l.status == "active"), None)
    total_hours = sum(l.total_hours or 0 for l in logs if l.status == "completed")
    return {
        "date": today_start.date().isoformat(),
        "is_punched_in": active_log is not None,
        "punch_in_time": active_log.punch_in_time.isoformat() + "Z" if active_log else None,
        "attendance_log_id": active_log.id if active_log else None,
        "total_hours_today": round(total_hours, 2),
        "total_shifts": len(logs),
        "tasks_today": len(tasks),
        "tasks_completed_today": sum(1 for t in tasks if t.status == "completed"),
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
        # For DM rooms show the OTHER person's name, not the combined "A & B" string
        if room.room_type == "direct":
            other = (db.query(ChatMember)
                     .filter(ChatMember.room_id == room.id, ChatMember.user_id != current_user.id)
                     .first())
            display_name = other.user.name if other else room.name
        else:
            display_name = room.name
        last_msg = (db.query(Message).filter(Message.room_id == room.id)
                    .order_by(Message.created_at.desc()).first())
        rooms.append({
            "id": room.id, "name": display_name, "room_type": room.room_type,
            "last_message": last_msg.content[:60] if last_msg else None,
            "last_message_time": last_msg.created_at.isoformat() + "Z" if last_msg else None,
            "last_sender": last_msg.sender.name if last_msg else None,
        })
    return rooms

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


# ── Places Proxy (Nominatim/OSM — no key restrictions) ────────────────────────
_OSM_HEADERS = {"User-Agent": "FieldPulse-App/2.0 (admin@fieldpulse.in)"}

@app.get("/api/places/autocomplete")
async def places_autocomplete(input: str, current_user: User = Depends(get_current_user)):
    async with httpx.AsyncClient(timeout=8.0, headers=_OSM_HEADERS) as client:
        res = await client.get(
            "https://nominatim.openstreetmap.org/search",
            params={"q": input, "format": "json", "limit": 5,
                    "countrycodes": "in", "addressdetails": 0},
        )
    results = res.json() if res.status_code == 200 else []
    predictions = [
        {"place_id": str(r["place_id"]),
         "description": r["display_name"],
         "lat": float(r["lat"]),
         "lon": float(r["lon"])}
        for r in results
    ]
    return {"predictions": predictions, "status": "OK"}

@app.get("/api/places/directions")
async def places_directions(origin: str, destination: str, current_user: User = Depends(get_current_user)):
    # OSRM public API for routing (open-source, no key)
    # origin/destination are "lat,lon" strings
    try:
        olat, olon = origin.split(",")
        dlat, dlon = destination.split(",")
        async with httpx.AsyncClient(timeout=10.0, headers=_OSM_HEADERS) as client:
            res = await client.get(
                f"https://router.project-osrm.org/route/v1/driving/{olon},{olat};{dlon},{dlat}",
                params={"overview": "full", "geometries": "polyline", "steps": "false"},
            )
        data = res.json()
        if data.get("code") == "Ok" and data.get("routes"):
            route = data["routes"][0]
            return {
                "routes": [{
                    "overview_polyline": {"points": route["geometry"]},
                    "legs": [{"distance": {"value": int(route["distance"])},
                              "duration": {"value": int(route["duration"])}}],
                }]
            }
    except Exception as e:
        log.warning(f"OSRM routing failed: {e}")
    return {"routes": []}


# ── Admin Routes ──────────────────────────────────────────────────────────────
@app.get("/api/admin/stats")
def admin_stats(admin: User = Depends(require_admin), db: Session = Depends(get_db)):
    return {
        "total_workers": db.query(User).filter(User.role == "field_worker").count(),
        "total_tasks": db.query(Task).count(),
        "completed_tasks": db.query(Task).filter(Task.status == "completed").count(),
        "active_shifts": db.query(AttendanceLog).filter(AttendanceLog.status == "active").count(),
        "pending_leaves": db.query(Leave).filter(Leave.status == "pending").count(),
    }

@app.get("/api/admin/users")
def admin_list_users(admin: User = Depends(require_admin), db: Session = Depends(get_db)):
    users = db.query(User).order_by(User.created_at).all()
    return [{"id": u.id, "name": u.name, "email": u.email, "role": u.role,
             "is_active": u.is_active, "photo_url": u.photo_url,
             "created_at": u.created_at.isoformat() if u.created_at else None} for u in users]

@app.post("/api/admin/users")
def admin_create_user(req: CreateUserRequest, admin: User = Depends(require_admin), db: Session = Depends(get_db)):
    if db.query(User).filter(User.email == req.email.lower().strip()).first():
        raise HTTPException(status_code=400, detail="Email already exists")
    user = User(name=req.name, email=req.email.lower().strip(),
                password=hash_password(req.password), role=req.role)
    db.add(user)
    db.commit()
    db.refresh(user)
    if req.role == "field_worker":
        db.add(LeaveBalance(user_id=user.id))
        # Add to general chat room
        room = db.query(ChatRoom).first()
        if room:
            db.add(ChatMember(room_id=room.id, user_id=user.id))
        db.commit()
    return {"id": user.id, "name": user.name, "email": user.email, "role": user.role}

@app.get("/api/admin/tasks")
def admin_list_tasks(admin: User = Depends(require_admin), db: Session = Depends(get_db)):
    tasks = db.query(Task).order_by(Task.created_at.desc()).all()
    return [{"id": t.id, "title": t.title, "location": t.location, "status": t.status,
             "client_name": t.client_name, "assignee_name": t.assignee.name if t.assignee else None,
             "assignee_email": t.assignee.email if t.assignee else None,
             "scheduled_time": t.scheduled_time.isoformat() if t.scheduled_time else None} for t in tasks]

@app.post("/api/admin/tasks")
async def admin_create_task(req: CreateTaskRequest, background: BackgroundTasks,
                             admin: User = Depends(require_admin), db: Session = Depends(get_db)):
    assignee = None
    if req.assignee_email:
        assignee = db.query(User).filter(User.email == req.assignee_email.lower().strip()).first()
    sched = None
    if req.scheduled_time:
        try:
            sched = datetime.fromisoformat(req.scheduled_time.replace("Z", ""))
        except Exception:
            pass
    task = Task(title=req.title, description=req.description, location=req.location,
                client_name=req.client_name, assignee_id=assignee.id if assignee else None,
                latitude=req.latitude, longitude=req.longitude,
                scheduled_time=sched, status="pending")
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
    sched = None
    if req.scheduled_time:
        try:
            sched = datetime.fromisoformat(req.scheduled_time.replace("Z", ""))
        except Exception:
            pass
    created = []
    for email in req.assignee_emails:
        assignee = db.query(User).filter(User.email == email.lower().strip()).first()
        task = Task(title=req.title, description=req.description, location=req.location,
                    client_name=req.client_name,
                    assignee_id=assignee.id if assignee else None,
                    latitude=req.latitude, longitude=req.longitude,
                    scheduled_time=sched, status="pending")
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
    logs = (db.query(AttendanceLog).order_by(AttendanceLog.punch_in_time.desc()).limit(200).all())
    return [{"id": l.id, "user_name": l.user.name, "user_email": l.user.email,
             "punch_in_time": l.punch_in_time.isoformat() + "Z",
             "punch_out_time": l.punch_out_time.isoformat() + "Z" if l.punch_out_time else None,
             "total_hours": l.total_hours, "status": l.status,
             "check_in_note": l.check_in_note} for l in logs]

@app.get("/api/admin/performance")
def admin_performance(admin: User = Depends(require_admin), db: Session = Depends(get_db)):
    workers = db.query(User).filter(User.role == "field_worker").all()
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
    workers = db.query(User).filter(User.role == "field_worker").all()
    result = []
    for w in workers:
        ping = (db.query(GPSPing).filter(GPSPing.user_id == w.id)
                .order_by(GPSPing.created_at.desc()).first())
        active = db.query(AttendanceLog).filter(AttendanceLog.user_id == w.id,
                                                  AttendanceLog.status == "active").first()
        if ping:
            result.append({
                "user_id": w.id, "name": w.name, "email": w.email,
                "latitude": ping.latitude, "longitude": ping.longitude,
                "last_seen": ping.created_at.isoformat() + "Z",
                "is_punched_in": active is not None,
            })
    return result

@app.get("/api/admin/geofence-alerts")
def geofence_alerts(admin: User = Depends(require_admin), db: Session = Depends(get_db)):
    breaches = (db.query(GPSPing).filter(GPSPing.is_breach == True)
                .order_by(GPSPing.created_at.desc()).limit(100).all())
    return [{"id": b.id, "user_name": b.user.name, "user_email": b.user.email,
             "latitude": b.latitude, "longitude": b.longitude,
             "timestamp": b.created_at.isoformat() + "Z",
             "task_id": b.task_id} for b in breaches]

@app.get("/api/admin/leaves")
def admin_leaves(admin: User = Depends(require_admin), db: Session = Depends(get_db)):
    leaves = db.query(Leave).order_by(Leave.created_at.desc()).all()
    return [{"id": l.id, "user_name": l.user.name, "user_email": l.user.email,
             "leave_type": l.leave_type, "start_date": l.start_date.date().isoformat(),
             "end_date": l.end_date.date().isoformat(), "days": l.days,
             "reason": l.reason, "status": l.status,
             "created_at": l.created_at.isoformat()} for l in leaves]

@app.put("/api/admin/leaves/{leave_id}")
def admin_leave_action(leave_id: str, req: LeaveActionRequest,
                       admin: User = Depends(require_admin), db: Session = Depends(get_db)):
    leave = db.query(Leave).filter(Leave.id == leave_id).first()
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
    logs = db.query(AttendanceLog).order_by(AttendanceLog.punch_in_time.desc()).all()
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
    now = datetime.utcnow()
    month_start = now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    workers = db.query(User).filter(User.role == "field_worker").all()
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
    users = db.query(User).filter(User.id != current_user.id, User.is_active == True).all()
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
