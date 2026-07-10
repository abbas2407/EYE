"""Seed initial users and sample tasks. Run once on first startup."""
from database import SessionLocal, engine, Base
from models import User, Task
from auth import hash_password
from datetime import datetime, timedelta
import logging

log = logging.getLogger(__name__)

USERS = [
    {"name": "Abbas",   "email": "abbas@fieldpulse.in",   "password": "Field@Abbas1",   "role": "field_worker"},
    {"name": "Mahemud", "email": "mahemud@fieldpulse.in", "password": "Field@Mahemud1", "role": "field_worker"},
    {"name": "Ahesan",  "email": "ahesan@fieldpulse.in",  "password": "Field@Ahesan1",  "role": "field_worker"},
    {"name": "Admin",   "email": "admin@fieldpulse.in",   "password": "Admin@FieldPulse1", "role": "admin"},
]

SAMPLE_TASKS = [
    {
        "title": "Site Inspection — Sector 7",
        "description": "Inspect electrical panel and report faults.",
        "location": "Sector 7, Hyderabad",
        "latitude": 17.385,
        "longitude": 78.4867,
        "client_name": "Tech Corp Ltd",
        "status": "pending",
        "scheduled_time": datetime.utcnow() + timedelta(hours=2),
        "form_fields": [
            {"id": "f1", "label": "Fault Description", "type": "textarea", "required": True},
            {"id": "f2", "label": "Severity",          "type": "select",   "required": True,
             "options": ["Low", "Medium", "High", "Critical"]},
            {"id": "f3", "label": "Resolved on site",  "type": "checkbox"},
        ],
    },
    {
        "title": "Equipment Delivery — HITEC City",
        "description": "Deliver and install 3 units of UPS.",
        "location": "HITEC City, Hyderabad",
        "latitude": 17.4435,
        "longitude": 78.3772,
        "client_name": "Cyber Solutions",
        "status": "upcoming",
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
        "latitude": 17.4401,
        "longitude": 78.3489,
        "client_name": "Startup Hub",
        "status": "completed",
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
            exists = db.query(User).filter(User.email == u["email"]).first()
            if not exists:
                db.add(User(
                    name=u["name"],
                    email=u["email"],
                    password=hash_password(u["password"]),
                    role=u["role"],
                ))
                log.info(f"Created user: {u['email']}")

        db.commit()

        # Assign sample tasks to Abbas
        abbas = db.query(User).filter(User.email == "abbas@fieldpulse.in").first()
        mahemud = db.query(User).filter(User.email == "mahemud@fieldpulse.in").first()
        ahesan = db.query(User).filter(User.email == "ahesan@fieldpulse.in").first()

        existing_tasks = db.query(Task).count()
        if existing_tasks == 0 and abbas:
            assignees = [abbas, mahemud, ahesan]
            for i, t in enumerate(SAMPLE_TASKS):
                assignee = assignees[i % len(assignees)]
                db.add(Task(assignee_id=assignee.id if assignee else None, **t))
            db.commit()
            log.info("Sample tasks created")
    finally:
        db.close()

if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    seed()
    print("Seed complete.")
