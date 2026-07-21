from sqlalchemy import Column, String, Boolean, DateTime, Float, Text, ForeignKey, Integer, JSON
from sqlalchemy.orm import relationship
from database import Base
import uuid
from datetime import datetime


def gen_id():
    return str(uuid.uuid4())


class Company(Base):
    __tablename__ = "companies"
    id                         = Column(String, primary_key=True, default=gen_id)
    name                       = Column(String, nullable=False)
    slug                       = Column(String, unique=True, nullable=False)
    contact_name               = Column(String, nullable=True)
    contact_email              = Column(String, nullable=True)
    contact_phone              = Column(String, nullable=True)
    # Plan: trial / starter / pro / enterprise
    plan                       = Column(String, default="trial")
    max_users                  = Column(Integer, default=10)
    # Dates
    trial_start                = Column(DateTime, nullable=True)
    trial_end                  = Column(DateTime, nullable=True)
    expires_at                 = Column(DateTime, nullable=True)
    grace_days                 = Column(Integer, default=3)
    # Status
    is_active                  = Column(Boolean, default=True)
    is_suspended               = Column(Boolean, default=False)
    suspension_reason          = Column(Text, nullable=True)
    # Billing
    auto_renew                 = Column(Boolean, default=False)
    discount_percent           = Column(Float, default=0.0)
    # Feature flags
    feature_gps                = Column(Boolean, default=True)
    feature_chat               = Column(Boolean, default=True)
    feature_leave              = Column(Boolean, default=True)
    feature_reports            = Column(Boolean, default=True)
    # Customisation
    logo_url                   = Column(String, nullable=True)
    working_hours_start        = Column(String, nullable=True)   # "09:00"
    working_hours_end          = Column(String, nullable=True)   # "18:00"
    gps_ping_interval          = Column(Integer, default=30)     # seconds
    # Security
    ip_whitelist               = Column(JSON, nullable=True)
    require_2fa                = Column(Boolean, default=False)
    # Geo-fence (office-only punch in/out)
    geo_fence_enabled          = Column(Boolean, default=False)
    office_name                = Column(String, nullable=True)
    office_lat                 = Column(Float, nullable=True)
    office_lng                 = Column(Float, nullable=True)
    office_radius_m            = Column(Integer, default=100)
    # Ops
    tags                       = Column(JSON, nullable=True)     # list[str]
    # Onboarding checklist
    onboarding_admin_logged_in = Column(Boolean, default=False)
    onboarding_employee_added  = Column(Boolean, default=False)
    onboarding_first_punch     = Column(Boolean, default=False)
    created_at                 = Column(DateTime, default=datetime.utcnow)
    updated_at                 = Column(DateTime, default=datetime.utcnow)

    invoices          = relationship("Invoice",         back_populates="company", cascade="all, delete-orphan")
    payments          = relationship("Payment",         back_populates="company", cascade="all, delete-orphan")
    notes             = relationship("CompanyNote",     back_populates="company", cascade="all, delete-orphan")
    tickets           = relationship("SupportTicket",   back_populates="company", cascade="all, delete-orphan")
    scheduled_actions = relationship("ScheduledAction", back_populates="company", cascade="all, delete-orphan")


class VendorAdmin(Base):
    __tablename__ = "vendor_admins"
    id         = Column(String, primary_key=True, default=gen_id)
    name       = Column(String, nullable=False)
    email      = Column(String, unique=True, nullable=False)
    password   = Column(String, nullable=False)
    is_active  = Column(Boolean, default=True)
    created_at = Column(DateTime, default=datetime.utcnow)
    audit_logs = relationship("AuditLog", back_populates="vendor_admin")


class Plan(Base):
    __tablename__ = "plans"
    id              = Column(String, primary_key=True, default=gen_id)
    name            = Column(String, unique=True, nullable=False)   # starter/pro/enterprise
    display_name    = Column(String, nullable=False)
    price_monthly   = Column(Float, nullable=False)
    max_users       = Column(Integer, nullable=False)
    feature_gps     = Column(Boolean, default=True)
    feature_chat    = Column(Boolean, default=True)
    feature_leave   = Column(Boolean, default=True)
    feature_reports = Column(Boolean, default=True)
    is_active       = Column(Boolean, default=True)
    created_at      = Column(DateTime, default=datetime.utcnow)


class Invoice(Base):
    __tablename__ = "invoices"
    id              = Column(String, primary_key=True, default=gen_id)
    company_id      = Column(String, ForeignKey("companies.id"), nullable=False)
    invoice_number  = Column(String, unique=True, nullable=False)
    amount          = Column(Float, nullable=False)
    discount_amount = Column(Float, default=0.0)
    final_amount    = Column(Float, nullable=False)
    plan            = Column(String, nullable=False)
    period_start    = Column(DateTime, nullable=False)
    period_end      = Column(DateTime, nullable=False)
    status          = Column(String, default="unpaid")   # unpaid/paid/cancelled
    paid_at         = Column(DateTime, nullable=True)
    notes           = Column(Text, nullable=True)
    created_at      = Column(DateTime, default=datetime.utcnow)
    company         = relationship("Company", back_populates="invoices")


class Payment(Base):
    __tablename__ = "payments"
    id         = Column(String, primary_key=True, default=gen_id)
    company_id = Column(String, ForeignKey("companies.id"), nullable=False)
    invoice_id = Column(String, ForeignKey("invoices.id"), nullable=True)
    amount     = Column(Float, nullable=False)
    method     = Column(String, nullable=True)    # cash/upi/bank/card
    reference  = Column(String, nullable=True)
    notes      = Column(Text, nullable=True)
    paid_at    = Column(DateTime, default=datetime.utcnow)
    company    = relationship("Company", back_populates="payments")


class PromoCode(Base):
    __tablename__ = "promo_codes"
    id               = Column(String, primary_key=True, default=gen_id)
    code             = Column(String, unique=True, nullable=False)
    discount_percent = Column(Float, nullable=False)
    max_uses         = Column(Integer, nullable=True)
    used_count       = Column(Integer, default=0)
    expires_at       = Column(DateTime, nullable=True)
    is_active        = Column(Boolean, default=True)
    created_at       = Column(DateTime, default=datetime.utcnow)


class Announcement(Base):
    __tablename__ = "announcements"
    id          = Column(String, primary_key=True, default=gen_id)
    title       = Column(String, nullable=False)
    message     = Column(Text, nullable=False)
    target      = Column(String, default="all")   # all / specific
    company_ids = Column(JSON, nullable=True)
    sent_at     = Column(DateTime, default=datetime.utcnow)
    sent_by     = Column(String, nullable=True)


class SupportTicket(Base):
    __tablename__ = "support_tickets"
    id          = Column(String, primary_key=True, default=gen_id)
    company_id  = Column(String, ForeignKey("companies.id"), nullable=False)
    title       = Column(String, nullable=False)
    description = Column(Text, nullable=False)
    status      = Column(String, default="open")     # open/in_progress/resolved/closed
    priority    = Column(String, default="normal")   # low/normal/high/urgent
    created_at  = Column(DateTime, default=datetime.utcnow)
    updated_at  = Column(DateTime, default=datetime.utcnow)
    company     = relationship("Company", back_populates="tickets")
    replies     = relationship("TicketReply", back_populates="ticket", cascade="all, delete-orphan")


class TicketReply(Base):
    __tablename__ = "ticket_replies"
    id         = Column(String, primary_key=True, default=gen_id)
    ticket_id  = Column(String, ForeignKey("support_tickets.id"), nullable=False)
    message    = Column(Text, nullable=False)
    is_vendor  = Column(Boolean, default=False)
    created_at = Column(DateTime, default=datetime.utcnow)
    ticket     = relationship("SupportTicket", back_populates="replies")


class AuditLog(Base):
    __tablename__ = "audit_logs"
    id              = Column(String, primary_key=True, default=gen_id)
    vendor_admin_id = Column(String, ForeignKey("vendor_admins.id"), nullable=True)
    action          = Column(String, nullable=False)
    resource        = Column(String, nullable=True)
    resource_id     = Column(String, nullable=True)
    details         = Column(JSON, nullable=True)
    ip_address      = Column(String, nullable=True)
    created_at      = Column(DateTime, default=datetime.utcnow)
    vendor_admin    = relationship("VendorAdmin", back_populates="audit_logs")


class LoginActivity(Base):
    __tablename__ = "login_activities"
    id         = Column(String, primary_key=True, default=gen_id)
    company_id = Column(String, ForeignKey("companies.id"), nullable=True)
    user_id    = Column(String, ForeignKey("users.id"), nullable=True)
    email      = Column(String, nullable=True)
    ip_address = Column(String, nullable=True)
    user_agent = Column(String, nullable=True)
    success    = Column(Boolean, default=True)
    created_at = Column(DateTime, default=datetime.utcnow)


class CompanyNote(Base):
    __tablename__ = "company_notes"
    id         = Column(String, primary_key=True, default=gen_id)
    company_id = Column(String, ForeignKey("companies.id"), nullable=False)
    note       = Column(Text, nullable=False)
    created_by = Column(String, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)
    company    = relationship("Company", back_populates="notes")


class ScheduledAction(Base):
    __tablename__ = "scheduled_actions"
    id           = Column(String, primary_key=True, default=gen_id)
    company_id   = Column(String, ForeignKey("companies.id"), nullable=False)
    action       = Column(String, nullable=False)   # suspend/extend/email
    scheduled_at = Column(DateTime, nullable=False)
    is_executed  = Column(Boolean, default=False)
    executed_at  = Column(DateTime, nullable=True)
    notes        = Column(Text, nullable=True)
    created_at   = Column(DateTime, default=datetime.utcnow)
    company      = relationship("Company", back_populates="scheduled_actions")
