"""Seed initial users, tasks, chat rooms, leave balances. Idempotent."""
from database import SessionLocal, engine, Base
from models import User, Task, LeaveBalance, ChatRoom, ChatMember
from auth import hash_password
from datetime import datetime, timedelta
import logging

log = logging.getLogger(__name__)

USERS = [
    {"name": "Abbas",   "email": "abbas@fieldpulse.in",   "password": "Field@Abbas1",      "role": "field_worker"},
    {"name": "Mahemud", "email": "mahemud@fieldpulse.in", "password": "Field@Mahemud1",    "role": "field_worker"},
    {"name": "Ahesan",  "email": "ahesan@fieldpulse.in",  "password": "Field@Ahesan1",     "role": "field_worker"},
    {"name": "Admin",   "email": "admin@fieldpulse.in",   "password": "Admin@FieldPulse1", "role": "admin"},
]

SAMPLE_TASKS = [
    {
        "title": "Site Inspection — Sector 7",
        "description": "Inspect electrical panel and report faults.",
        "location": "Sector 7, Hyderabad",
        "latitude": 17.385, "longitude": 78.4867,
        "client_name": "Tech Corp Ltd", "status": "pending",
        "geofence_radius": 200.0,
        "scheduled_time": datetime.utcnow() + timedelta(hours=2),
        "form_fields": [
            {"id": "f1", "label": "Fault Description", "type": "textarea", "required": True},
            {"id": "f2", "label": "Severity", "type": "select", "required": True,
             "options": ["Low", "Medium", "High", "Critical"]},
            {"id": "f3", "label": "Resolved on site", "type": "checkbox"},
        ],
    },
    {
        "title": "Equipment Delivery — HITEC City",
        "description": "Deliver and install 3 units of UPS.",
        "location": "HITEC City, Hyderabad",
        "latitude": 17.4435, "longitude": 78.3772,
        "client_name": "Cyber Solutions", "status": "upcoming",
        "geofence_radius": 200.0,
        "scheduled_time": datetime.utcnow() + timedelta(hours=4),
        "form_fields": [
            {"id": "f1", "label": "Units Delivered", "type": "number", "required": True},
            {"id": "f2", "label": "Client Signature Obtained", "type": "checkbox"},
            {"id": "f3", "label": "Notes", "type": "textarea"},
        ],
    },
    {
        "title": "Network Setup — Gachibowli",
        "description": "Configure LAN and test internet connectivity.",
        "location": "Gachibowli, Hyderabad",
        "latitude": 17.4401, "longitude": 78.3489,
        "client_name": "Startup Hub", "status": "completed",
        "geofence_radius": 200.0,
        "scheduled_time": datetime.utcnow() - timedelta(hours=3),
        "form_fields": [],
    },
]

def seed():
    Base.metadata.create_all(bind=engine)
    db = SessionLocal()
    try:
        # Seed users
        for u in USERS:
            if not db.query(User).filter(User.email == u["email"]).first():
                db.add(User(name=u["name"], email=u["email"],
                            password=hash_password(u["password"]), role=u["role"]))
        db.commit()

        # Seed leave balances
        workers = db.query(User).filter(User.role == "field_worker").all()
        for w in workers:
            if not db.query(LeaveBalance).filter(LeaveBalance.user_id == w.id).first():
                db.add(LeaveBalance(user_id=w.id))
        db.commit()

        # Seed tasks
        if db.query(Task).count() == 0:
            assignees = workers
            for i, t in enumerate(SAMPLE_TASKS):
                a = assignees[i % len(assignees)] if assignees else None
                db.add(Task(assignee_id=a.id if a else None, **t))
            db.commit()

        # Seed general chat room
        if db.query(ChatRoom).count() == 0:
            room = ChatRoom(name="FieldPulse Team", room_type="group")
            db.add(room)
            db.commit()
            all_users = db.query(User).all()
            for u in all_users:
                db.add(ChatMember(room_id=room.id, user_id=u.id))
            db.commit()
            log.info("Chat room created")

    finally:
        db.close()

if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    seed()
    print("Seed complete.")
