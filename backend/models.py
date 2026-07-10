from sqlalchemy import Column, String, Boolean, DateTime, Float, Text, ForeignKey, Integer, JSON
from sqlalchemy.orm import relationship
from database import Base
import uuid
from datetime import datetime

def gen_id():
    return str(uuid.uuid4())

class User(Base):
    __tablename__ = "users"
    id           = Column(String, primary_key=True, default=gen_id)
    name         = Column(String, nullable=False)
    email        = Column(String, unique=True, index=True, nullable=False)
    password     = Column(String, nullable=False)
    role         = Column(String, default="field_worker")  # field_worker | manager | admin
    device_uuid  = Column(String, nullable=True)
    is_active    = Column(Boolean, default=True)
    created_at   = Column(DateTime, default=datetime.utcnow)

    attendance_logs = relationship("AttendanceLog", back_populates="user")
    tasks           = relationship("Task", back_populates="assignee")

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
    status         = Column(String, default="active")  # active | completed

    user = relationship("User", back_populates="attendance_logs")

class Task(Base):
    __tablename__ = "tasks"
    id             = Column(String, primary_key=True, default=gen_id)
    title          = Column(String, nullable=False)
    description    = Column(Text, nullable=True)
    location       = Column(String, nullable=True)
    latitude       = Column(Float, nullable=True)
    longitude      = Column(Float, nullable=True)
    scheduled_time = Column(DateTime, nullable=True)
    status         = Column(String, default="pending")
    client_name    = Column(String, nullable=True)
    form_fields    = Column(JSON, nullable=True)
    form_data      = Column(JSON, nullable=True)
    assignee_id    = Column(String, ForeignKey("users.id"), nullable=True)
    created_at     = Column(DateTime, default=datetime.utcnow)

    assignee = relationship("User", back_populates="tasks")

class UploadedFile(Base):
    __tablename__ = "uploaded_files"
    id         = Column(String, primary_key=True, default=gen_id)
    filename   = Column(String, nullable=False)
    url        = Column(String, nullable=False)
    created_at = Column(DateTime, default=datetime.utcnow)
