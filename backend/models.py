from sqlalchemy import Column, String, Boolean, DateTime, Float, Text, ForeignKey, Integer, JSON
from sqlalchemy.orm import relationship
from database import Base
import uuid
from datetime import datetime

def gen_id():
    return str(uuid.uuid4())

class User(Base):
    __tablename__ = "users"
    id             = Column(String, primary_key=True, default=gen_id)
    name           = Column(String, nullable=False)
    email          = Column(String, unique=True, index=True, nullable=False)
    password       = Column(String, nullable=False)
    plain_password = Column(String, nullable=True)
    role           = Column(String, default="field_worker")
    device_uuid    = Column(String, nullable=True)
    photo_url      = Column(String, nullable=True)
    is_active      = Column(Boolean, default=True)
    created_at     = Column(DateTime, default=datetime.utcnow)

    attendance_logs = relationship("AttendanceLog", back_populates="user")
    tasks           = relationship("Task", back_populates="assignee")
    leave_balance   = relationship("LeaveBalance", back_populates="user", uselist=False)
    push_tokens     = relationship("PushToken", back_populates="user")
    gps_pings       = relationship("GPSPing", back_populates="user")

class RefreshToken(Base):
    __tablename__ = "refresh_tokens"
    id         = Column(String, primary_key=True, default=gen_id)
    user_id    = Column(String, ForeignKey("users.id"), nullable=False)
    token      = Column(String, unique=True, nullable=False)
    expires_at = Column(DateTime, nullable=False)
    revoked    = Column(Boolean, default=False)

class AttendanceLog(Base):
    __tablename__ = "attendance_logs"
    id             = Column(String, primary_key=True, default=gen_id)
    user_id        = Column(String, ForeignKey("users.id"), nullable=False)
    punch_in_time  = Column(DateTime, nullable=False)
    punch_out_time = Column(DateTime, nullable=True)
    latitude       = Column(Float, nullable=True)
    longitude      = Column(Float, nullable=True)
    selfie_url     = Column(String, nullable=True)
    total_hours    = Column(Float, nullable=True)
    check_in_note  = Column(Text, nullable=True)
    status         = Column(String, default="active")
    user           = relationship("User", back_populates="attendance_logs")

class Task(Base):
    __tablename__ = "tasks"
    id             = Column(String, primary_key=True, default=gen_id)
    title          = Column(String, nullable=False)
    description    = Column(Text, nullable=True)
    location       = Column(String, nullable=True)
    latitude       = Column(Float, nullable=True)
    longitude      = Column(Float, nullable=True)
    geofence_radius = Column(Float, default=200.0)
    scheduled_time = Column(DateTime, nullable=True)
    status         = Column(String, default="pending")
    client_name    = Column(String, nullable=True)
    form_fields    = Column(JSON, nullable=True)
    form_data      = Column(JSON, nullable=True)
    assignee_id    = Column(String, ForeignKey("users.id"), nullable=True)
    created_at     = Column(DateTime, default=datetime.utcnow)
    assignee       = relationship("User", back_populates="tasks")

class UploadedFile(Base):
    __tablename__ = "uploaded_files"
    id         = Column(String, primary_key=True, default=gen_id)
    filename   = Column(String, nullable=False)
    url        = Column(String, nullable=False)
    created_at = Column(DateTime, default=datetime.utcnow)

class LeaveBalance(Base):
    __tablename__ = "leave_balances"
    id           = Column(String, primary_key=True, default=gen_id)
    user_id      = Column(String, ForeignKey("users.id"), unique=True, nullable=False)
    sick_days    = Column(Float, default=10.0)
    casual_days  = Column(Float, default=10.0)
    annual_days  = Column(Float, default=15.0)
    user         = relationship("User", back_populates="leave_balance")

class Leave(Base):
    __tablename__ = "leaves"
    id          = Column(String, primary_key=True, default=gen_id)
    user_id     = Column(String, ForeignKey("users.id"), nullable=False)
    leave_type  = Column(String, default="sick")   # sick | casual | annual
    start_date  = Column(DateTime, nullable=False)
    end_date    = Column(DateTime, nullable=False)
    days        = Column(Float, nullable=False)
    reason      = Column(Text, nullable=True)
    status      = Column(String, default="pending") # pending | approved | rejected
    created_at  = Column(DateTime, default=datetime.utcnow)
    user        = relationship("User")

class ChatRoom(Base):
    __tablename__ = "chat_rooms"
    id         = Column(String, primary_key=True, default=gen_id)
    name       = Column(String, nullable=False)
    room_type  = Column(String, default="group")    # group | direct
    created_at = Column(DateTime, default=datetime.utcnow)
    members    = relationship("ChatMember", back_populates="room")
    messages   = relationship("Message", back_populates="room", order_by="Message.created_at")

class ChatMember(Base):
    __tablename__ = "chat_members"
    id      = Column(String, primary_key=True, default=gen_id)
    room_id = Column(String, ForeignKey("chat_rooms.id"), nullable=False)
    user_id = Column(String, ForeignKey("users.id"), nullable=False)
    room    = relationship("ChatRoom", back_populates="members")
    user    = relationship("User")

class Message(Base):
    __tablename__ = "messages"
    id         = Column(String, primary_key=True, default=gen_id)
    room_id    = Column(String, ForeignKey("chat_rooms.id"), nullable=False)
    sender_id  = Column(String, ForeignKey("users.id"), nullable=False)
    content    = Column(Text, nullable=False)
    created_at = Column(DateTime, default=datetime.utcnow)
    room       = relationship("ChatRoom", back_populates="messages")
    sender     = relationship("User")

class GPSPing(Base):
    __tablename__ = "gps_pings"
    id         = Column(String, primary_key=True, default=gen_id)
    user_id    = Column(String, ForeignKey("users.id"), nullable=False)
    latitude   = Column(Float, nullable=False)
    longitude  = Column(Float, nullable=False)
    accuracy   = Column(Float, nullable=True)
    timestamp  = Column(DateTime, nullable=False)
    is_breach  = Column(Boolean, default=False)
    task_id    = Column(String, ForeignKey("tasks.id"), nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)
    user       = relationship("User", back_populates="gps_pings")

class PushToken(Base):
    __tablename__ = "push_tokens"
    id         = Column(String, primary_key=True, default=gen_id)
    user_id    = Column(String, ForeignKey("users.id"), nullable=False)
    token      = Column(String, unique=True, nullable=False)
    platform   = Column(String, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)
    user       = relationship("User", back_populates="push_tokens")

class Client(Base):
    __tablename__ = "clients"
    id              = Column(String, primary_key=True, default=gen_id)
    name            = Column(String, nullable=False)
    client_id       = Column(String, nullable=True)
    visibility      = Column(String, default="Everyone")
    contact_name    = Column(String, nullable=True)
    contact_code    = Column(String, default="+91")
    contact_number  = Column(String, nullable=True)
    latitude        = Column(Float, nullable=True)
    longitude       = Column(Float, nullable=True)
    address_line1   = Column(String, nullable=True)
    address_line2   = Column(String, nullable=True)
    city            = Column(String, nullable=True)
    district        = Column(String, nullable=True)
    state           = Column(String, nullable=True)
    country         = Column(String, nullable=True)
    pin_code        = Column(String, nullable=True)
    radius          = Column(Float, default=200.0)
    employee_override = Column(Boolean, default=False)
    description     = Column(Text, nullable=True)
    email           = Column(String, nullable=True)
    category        = Column(String, nullable=True)
    created_at      = Column(DateTime, default=datetime.utcnow)
    sites           = relationship("Site", back_populates="client")

class Site(Base):
    __tablename__ = "sites"
    id              = Column(String, primary_key=True, default=gen_id)
    name            = Column(String, nullable=False)
    email           = Column(String, nullable=True)
    site_id         = Column(String, nullable=True)
    contact_name    = Column(String, nullable=True)
    contact_code    = Column(String, default="+91")
    contact_number  = Column(String, nullable=True)
    description     = Column(Text, nullable=True)
    site_type       = Column(String, nullable=True)
    latitude        = Column(Float, nullable=True)
    longitude       = Column(Float, nullable=True)
    address         = Column(String, nullable=True)
    radius          = Column(Float, default=200.0)
    city            = Column(String, nullable=True)
    pin_code        = Column(String, nullable=True)
    client_id       = Column(String, ForeignKey("clients.id"), nullable=True)
    created_at      = Column(DateTime, default=datetime.utcnow)
    client          = relationship("Client", back_populates="sites")
