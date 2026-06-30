import { useState, useEffect } from "react";
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell } from "recharts";

// ── Config ────────────────────────────────────────────────────────────────────
const OPEN_HOUR   = 8;
const CLOSE_HOUR  = 17;
const STORAGE_KEY  = "mechshop-bookings-v1";
const SETTINGS_KEY = "mechshop-settings-v1";
const DEFAULT_SETTINGS = {
  totalBays:      3,
  dayOverrides:   {},
  services:       null,
  slotHours:      [8, 10, 13, 15],
  openHour:       8,
  closeHour:      17,
  bookingMonths:  2,
  customHolidays:       [],
  openSaturday:         false,
  openSunday:           false,
  adminPasswordHash:    null,   // SHA-256 hash — never stored in plain text
  adminPasswordChanged: false,  // true once changed from default
  requireApproval:      false,  // if true, all bookings need admin approval
  emailjs: { enabled: false, serviceId: "", templateId: "", publicKey: "" },
  dayHours: {
    monday:    { open: 8, close: 17 },
    tuesday:   { open: 8, close: 17 },
    wednesday: { open: 8, close: 17 },
    thursday:  { open: 8, close: 17 },
    friday:    { open: 8, close: 17 },
    saturday:  { open: 8, close: 17 },
    sunday:    { open: 8, close: 17 },
  },
};

const SERVICES = [
  { id: "oil",         name: "Oil Change",          duration: 1, price: "$65 / $99.95",      desc: "Synthetic blend $65 · Full synthetic $99.95" },
  { id: "alignment",   name: "Alignment",           duration: 2, price: "$119.95 / $159.95", desc: "Cars & minivans $119.95 · Trucks & SUVs $159.95" },
  { id: "inspection",  name: "State Inspection",    duration: 1, price: "$53.99 + $12 sticker", desc: "State inspection fee $53.99 · Required sticker $12" },
  { id: "brakes-one",  name: "Brakes & Rotors — One Axle",   duration: 2, price: "~$450",  desc: "Pads, rotors, and hardware — front or rear axle. Price is an average and may vary depending on vehicle make and parts needed." },
  { id: "brakes-both", name: "Brakes & Rotors — Both Axles", duration: 3, price: "~$900",  desc: "Full brake job — front and rear axles. Price is an average and may vary depending on vehicle make and parts needed." },
  { id: "other",       name: "Other",               duration: 2, price: "Quote",              desc: "Not sure what you need? We'll take a look and get you a quote." },
];

const TIME_SLOTS = [8, 10, 13, 15].map(h => {
  const label = h < 12 ? `${h}:00 AM` : h === 12 ? "12:00 PM" : `${h - 12}:00 PM`;
  const short = h < 12 ? `${h}a` : h === 12 ? "12p" : `${h - 12}p`;
  return { value: h, label, short };
});

// ── Design tokens ─────────────────────────────────────────────────────────────
const T = {
  yellow:    "#0057E7",
  yellowBg:  "#EBF2FF",
  black:     "#111111",
  gray:      "#666666",
  lightGray: "#E0E0E0",
  offWhite:  "#F7F7F7",
  white:     "#FFFFFF",
  red:       "#D94032",
};

// ── Storage helpers ───────────────────────────────────────────────────────────
// ── Crypto ────────────────────────────────────────────────────────────────────
// Lockout tracking lives at module level — persists while the page is open,
// but is completely isolated per browser/device. A customer on their phone
// failing attempts has no effect on the admin on the shop computer.
let _loginAttempts = 0;
let _lockedUntil   = 0;

async function hashPassword(pwd) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(pwd));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join("");
}

async function loadBookings() {
  try {
    const r = await window.storage.get(STORAGE_KEY, true);
    return r ? JSON.parse(r.value) : [];
  } catch { return []; }
}

async function saveBookings(list) {
  try { await window.storage.set(STORAGE_KEY, JSON.stringify(list), true); }
  catch (e) { console.error("Storage error:", e); }
}

async function loadSettings() {
  let s = { ...DEFAULT_SETTINGS };
  try {
    const r = await window.storage.get(SETTINGS_KEY, true);
    if (r) s = { ...DEFAULT_SETTINGS, ...JSON.parse(r.value) };
  } catch { /* storage unavailable, use defaults */ }

  // Always ensure a password hash is set — never leave it null
  if (!s.adminPasswordHash) {
    try {
      s.adminPasswordHash = await hashPassword(s.adminPin ?? "1234");
      delete s.adminPin;
      await saveSettings(s);
    } catch { /* crypto unavailable — modal will handle null gracefully */ }
  }
  return s;
}

async function saveSettings(s) {
  try { await window.storage.set(SETTINGS_KEY, JSON.stringify(s), true); }
  catch (e) { console.error("Settings error:", e); }
}

function getEffectiveBays(settings, date) {
  if (date && settings.dayOverrides?.[date] !== undefined) return settings.dayOverrides[date];
  return settings.totalBays;
}

function genId() {
  return "BK-" + Math.random().toString(36).slice(2, 8).toUpperCase();
}

// ── Email confirmation ────────────────────────────────────────────────────────
async function sendConfirmationEmail(booking, settings) {
  const cfg = settings?.emailjs;
  if (!cfg?.enabled || !cfg?.serviceId || !cfg?.templateId || !cfg?.publicKey) return;
  if (!booking.email) return;
  try {
    const svcs  = getServices(settings);
    const slots = getTimeSlots(settings);
    await fetch("https://api.emailjs.com/api/v1.0/email/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        service_id:   cfg.serviceId,
        template_id:  cfg.templateId,
        user_id:      cfg.publicKey,
        template_params: {
          to_name:    booking.name,
          to_email:   booking.email,
          services:   svcs.filter(s => (booking.serviceIds || []).includes(s.id)).map(s => s.name).join(", "),
          date:       booking.date ? displayDate(booking.date) : "",
          time:       slots.find(t => t.value === booking.hour)?.label ?? "",
          vehicle:    `${booking.year} ${booking.make} ${booking.model}`,
          shop_name:  "Butler Tires for Less",
          shop_phone: "(724) 283-8473",
        },
      }),
    });
  } catch (e) { console.error("Email send failed:", e); }
}

// ── Settings-aware helpers ────────────────────────────────────────────────────
const getServices   = (cfg) => cfg?.services   ?? SERVICES;
const getSlotHours  = (cfg) => cfg?.slotHours  ?? [8, 10, 13, 15];
const getCloseHour  = (cfg) => cfg?.closeHour  ?? CLOSE_HOUR;
const getOpenHour   = (cfg) => cfg?.openHour   ?? OPEN_HOUR;
const DAY_KEYS = ["sunday","monday","tuesday","wednesday","thursday","friday","saturday"];
function getDayHours(settings, ds) {
  const dow = new Date(ds + "T12:00:00").getDay();
  const key = DAY_KEYS[dow];
  const saved = settings?.dayHours?.[key];
  return saved ?? { open: settings?.openHour ?? OPEN_HOUR, close: settings?.closeHour ?? CLOSE_HOUR };
}
const getMaxDate    = (cfg) => { const d = new Date(); d.setMonth(d.getMonth() + (cfg?.bookingMonths ?? 2)); return d.toISOString().split("T")[0]; };
const getTimeSlots  = (cfg) => getSlotHours(cfg).map(h => {
  const label = h < 12 ? `${h}:00 AM` : h === 12 ? "12:00 PM" : `${h - 12}:00 PM`;
  const short = h < 12 ? `${h}a` : h === 12 ? "12p" : `${h - 12}p`;
  return { value: h, label, short };
});
function isDateClosed(ds, cfg) {
  if (isHolidayClosed(ds)) return true;
  return (cfg?.customHolidays ?? []).some(h => h.date === ds);
}
function isWeekendClosed(ds, cfg) {
  const day = new Date(ds + "T12:00:00").getDay();
  if (day === 6) return !(cfg?.openSaturday ?? false);
  if (day === 0) return !(cfg?.openSunday   ?? false);
  return false;
}
const fmtHour = (h) => h < 12 ? `${h}:00 AM` : h === 12 ? "12:00 PM" : `${h - 12}:00 PM`;
function getOccupiedBaysAt(bookings, date, startHour, duration, settings) {
  const svcs = getServices(settings);
  const occupied = new Set();
  for (const b of bookings.filter(b => b.status === "confirmed" && b.date === date)) {
    const ids = b.serviceIds || (b.serviceId ? [b.serviceId] : []);
    const dur = ids.reduce((s, id) => s + (svcs.find(sv => sv.id === id)?.duration ?? 0), 0) || 1;
    if (startHour < b.hour + dur && startHour + duration > b.hour) occupied.add(b.bay);
  }
  return occupied;
}

function getSlots(bookings, date, duration, closeHour = CLOSE_HOUR, effectiveBays = 3, settings) {
  return getTimeSlots(settings).map(sl => {
    if (sl.value + duration > closeHour) return { ...sl, available: false, freeBay: null };
    const occupied = getOccupiedBaysAt(bookings, date, sl.value, duration, settings);
    const freeBay = Array.from({ length: effectiveBays }, (_, i) => i + 1).find(b => !occupied.has(b)) ?? null;
    return { ...sl, available: !!freeBay, freeBay };
  });
}

// ── Date helpers ──────────────────────────────────────────────────────────────
const todayStr = () => new Date().toISOString().split("T")[0];
const minDate  = () => { const d = new Date(); d.setDate(d.getDate() + 1); return d.toISOString().split("T")[0]; };
const isSunday = (s) => { const [y, m, d] = s.split("-"); const day = new Date(+y, +m - 1, +d).getDay(); return day === 0 || day === 6; };
const toDateStr = (d) => d.toISOString().split("T")[0];
const addDays   = (d, n) => { const r = new Date(d); r.setDate(r.getDate() + n); return r; };
const getWeekStart = (d) => { const r = new Date(d); const dow = r.getDay(); r.setDate(r.getDate() - (dow === 0 ? 6 : dow - 1)); return r; };
const getBkDuration = (bk, svcs) => {
  if (bk.customDuration) return bk.customDuration;
  const s = svcs ?? SERVICES;
  return (bk.serviceIds || (bk.serviceId ? [bk.serviceId] : [])).reduce((acc, id) => acc + (s.find(sv => sv.id === id)?.duration ?? 0), 0) || 1;
};
const getBkNames    = (bk, svcs) => { const s = svcs ?? SERVICES; return s.filter(sv => (bk.serviceIds || [bk.serviceId]).includes(sv.id)).map(sv => sv.name).join(", "); };

function findNextAvailable(bookings, settings, duration) {
  if (!duration) return null;
  const start = new Date(); start.setDate(start.getDate() + 1);
  const maxDays = (settings?.bookingMonths ?? 2) * 32;
  for (let i = 0; i < maxDays; i++) {
    const d = addDays(start, i);
    const ds = toDateStr(d);
    if (isWeekendClosed(ds, settings) || isDateClosed(ds, settings)) continue;
    const hd  = isHalfDay(ds);
    const eb  = getEffectiveBays(settings, ds);
    const dh  = getDayHours(settings, ds);
    const ch  = hd ? 12 : dh.close;
    const slots = getSlots(bookings, ds, duration, ch, eb, settings);
    const first = slots.find(s => s.available);
    if (first) return { date: ds, slot: first };
  }
  return null;
}

// ── Holiday helpers ───────────────────────────────────────────────────────────
function getEaster(year) {
  const a = year % 19, b = Math.floor(year / 100), c = year % 100;
  const d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m2 = Math.floor((a + 11 * h + 22 * l) / 451);
  const mo = Math.floor((h + l - 7 * m2 + 114) / 31);
  const dy = ((h + l - 7 * m2 + 114) % 31) + 1;
  return `${year}-${String(mo).padStart(2, "0")}-${String(dy).padStart(2, "0")}`;
}

function getThanksgiving(year) {
  const nov1 = new Date(year, 10, 1);
  const dow = nov1.getDay();
  const firstThur = dow <= 4 ? 1 + (4 - dow) : 1 + (11 - dow);
  return `${year}-11-${String(firstThur + 21).padStart(2, "0")}`;
}

function getMemorialDay(year) {
  // Last Monday of May
  const may31 = new Date(year, 4, 31);
  const dow = may31.getDay();
  const day = 31 - (dow === 0 ? 6 : dow - 1);
  return `${year}-05-${String(day).padStart(2, "0")}`;
}

function getLaborDay(year) {
  // First Monday of September
  const sep1 = new Date(year, 8, 1);
  const dow = sep1.getDay();
  const day = dow === 1 ? 1 : 1 + (8 - dow) % 7;
  return `${year}-09-${String(day).padStart(2, "0")}`;
}

function isHolidayClosed(s) {
  const [y, m, d] = s.split("-").map(Number);
  const mmdd = `${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  if (["01-01", "07-04", "12-25"].includes(mmdd)) return true;
  if (getEaster(y) === s) return true;
  if (getThanksgiving(y) === s) return true;
  if (getMemorialDay(y) === s) return true;
  if (getLaborDay(y) === s) return true;
  return false;
}

function isHalfDay(s) {
  const [, m, d] = s.split("-").map(Number);
  const mmdd = `${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  return ["12-24", "12-31"].includes(mmdd);
}

function displayDate(s) {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });
}

// ── Shared styles ─────────────────────────────────────────────────────────────
const btn = {
  primary:  { background: T.yellow,    color: T.white, border: "none", borderRadius: "8px", padding: "11px 28px", fontSize: "14px", fontWeight: 700, cursor: "pointer",      fontFamily: "inherit" },
  disabled: { background: T.lightGray, color: "#aaa",  border: "none", borderRadius: "8px", padding: "11px 28px", fontSize: "14px", fontWeight: 700, cursor: "not-allowed",  fontFamily: "inherit" },
  ghost:    { background: "transparent", color: T.gray, border: `1px solid ${T.lightGray}`, borderRadius: "8px", padding: "11px 20px", fontSize: "14px", cursor: "pointer", fontFamily: "inherit" },
};

const inputStyle = {
  width: "100%", padding: "10px 12px", border: `1px solid ${T.lightGray}`,
  borderRadius: "6px", fontSize: "14px", outline: "none", background: T.white,
  boxSizing: "border-box", fontFamily: "inherit", color: T.black,
};

const labelStyle = {
  display: "block", fontSize: "11px", fontWeight: 700, color: T.gray,
  textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: "5px",
};

const sectionLabel = {
  margin: "0 0 12px", fontSize: "11px", fontWeight: 700,
  textTransform: "uppercase", letterSpacing: "0.08em", color: T.gray,
};

// ── Mobile hook ───────────────────────────────────────────────────────────────
function useMobile() {
  const [mobile, setMobile] = useState(window.innerWidth < 640);
  useEffect(() => {
    const h = () => setMobile(window.innerWidth < 640);
    window.addEventListener("resize", h);
    return () => window.removeEventListener("resize", h);
  }, []);
  return mobile;
}

// ── Root ──────────────────────────────────────────────────────────────────────
export default function App() {
  const [view, setView]               = useState("booking");
  const [bookings, setBookings]       = useState([]);
  const [settings, setSettings]       = useState({ ...DEFAULT_SETTINGS });
  const [ready, setReady]             = useState(false);
  const [adminUnlocked, setAdminUnlocked] = useState(false);
  const [showPinModal, setShowPinModal]   = useState(false);
  const [lastRefresh, setLastRefresh]     = useState(null);
  const isMobile = useMobile();

  useEffect(() => {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = "https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;700&family=Inter:wght@400;500;600&display=swap";
    document.head.appendChild(link);
    loadBookings().then(b => { setBookings(b); setReady(true); setLastRefresh(new Date()); });
    loadSettings().then(s => setSettings(s));

    // Auto-refresh bookings every 30 seconds
    const interval = setInterval(() => {
      loadBookings().then(b => { setBookings(b); setLastRefresh(new Date()); });
    }, 30000);
    return () => clearInterval(interval);
  }, []);

  const addBooking = async (b) => {
    const next = [...bookings, b];
    setBookings(next);
    await saveBookings(next);
  };

  const cancelBooking = async (id) => {
    const next = bookings.map(b => b.id === id ? { ...b, status: "cancelled" } : b);
    setBookings(next);
    await saveBookings(next);
  };

  const updateBooking = async (id, changes) => {
    const next = bookings.map(b => b.id === id ? { ...b, ...changes } : b);
    setBookings(next);
    await saveBookings(next);
  };

  const clearBookings = async (filterFn) => {
    const next = bookings.filter(filterFn);
    setBookings(next);
    await saveBookings(next);
  };

  const updateSettings = async (changes) => {
    const next = { ...settings, ...changes };
    setSettings(next);
    await saveSettings(next);
  };

  if (!ready) return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100vh", background: T.offWhite, fontFamily: "system-ui" }}>
      <span style={{ color: T.gray, fontSize: "14px" }}>Loading…</span>
    </div>
  );

  return (
    <div style={{ fontFamily: "'Inter', system-ui, sans-serif", minHeight: "100vh", background: T.offWhite, color: T.black }}>
      {showPinModal && (
        <PasswordModal
          passwordHash={settings.adminPasswordHash}
          isDefault={!settings.adminPasswordChanged}
          onSuccess={() => { setAdminUnlocked(true); setView("admin"); setShowPinModal(false); }}
          onClose={() => setShowPinModal(false)}
        />
      )}
      {/* Nav */}
      <nav style={{ background: T.black, height: "52px", display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0 16px", gap: "8px" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: "1px", flexShrink: 0 }}>
          <span style={{ color: T.yellow, fontFamily: "'Space Grotesk', system-ui, sans-serif", fontWeight: 700, fontSize: isMobile ? "13px" : "15px", letterSpacing: "0.04em", textTransform: "uppercase", lineHeight: 1 }}>
            Butler Tires for Less
          </span>
          {!isMobile && (
            <span style={{ color: "#888", fontFamily: "'Space Grotesk', system-ui, sans-serif", fontWeight: 500, fontSize: "11px", letterSpacing: "0.08em", textTransform: "uppercase", lineHeight: 1 }}>
              Service Scheduling
            </span>
          )}
        </div>
        <div style={{ display: "flex", gap: "4px", alignItems: "center" }}>
          <div style={{ display: "flex", gap: "3px" }}>
            {[["booking", isMobile ? "Book" : "Book Appointment"], ["admin", "Admin"]].map(([v, l]) => {
              const pendingCount = v === "admin" ? bookings.filter(b => b.status === "pending").length : 0;
              return (
                <button key={v} onClick={() => {
                  if (v === "admin" && !adminUnlocked) { setShowPinModal(true); return; }
                  setView(v);
                }} style={{
                  background: view === v ? T.yellow : "transparent",
                  color: view === v ? T.white : "#888",
                  border: "none", borderRadius: "5px", padding: "5px 14px",
                  fontSize: "13px", fontWeight: 600, cursor: "pointer", fontFamily: "inherit",
                  position: "relative",
                }}>
                  {l}
                  {pendingCount > 0 && (
                    <span style={{ position: "absolute", top: "-4px", right: "-4px", background: "#F59E0B", color: T.white, borderRadius: "50%", width: "16px", height: "16px", fontSize: "10px", fontWeight: 700, display: "flex", alignItems: "center", justifyContent: "center" }}>
                      {pendingCount}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
          {view === "admin" && adminUnlocked && (
            <button onClick={() => { setAdminUnlocked(false); setView("booking"); }}
              style={{ background: "transparent", border: "1px solid #444", color: "#888", borderRadius: "5px", padding: "5px 12px", fontSize: "12px", cursor: "pointer", fontFamily: "inherit", display: "flex", alignItems: "center", gap: "5px" }}>
              🔒 Lock
            </button>
          )}
        </div>
      </nav>

      {view === "booking"
        ? <BookingFlow bookings={bookings} onBook={addBooking} settings={settings} isMobile={isMobile} />
        : <AdminView  bookings={bookings} onCancel={cancelBooking} onUpdate={updateBooking} onBook={addBooking} onClear={clearBookings} settings={settings} onUpdateSettings={updateSettings} isMobile={isMobile} lastRefresh={lastRefresh} />}
    </div>
  );
}

// ── Password Modal ────────────────────────────────────────────────────────────
function PasswordModal({ passwordHash, isDefault, onSuccess, onClose }) {
  const [pwd, setPwd]           = useState("");
  const [showPwd, setShowPwd]   = useState(false);
  const [checking, setChecking] = useState(false);
  const [error, setError]       = useState("");
  const [, rerender]            = useState(0); // triggers re-render when lockout state changes
  const [remaining, setRemaining] = useState(0);

  // Sync countdown timer from module-level lockedUntil
  useEffect(() => {
    if (_lockedUntil <= Date.now()) return;
    const t = setInterval(() => {
      const rem = Math.ceil((_lockedUntil - Date.now()) / 1000);
      if (rem <= 0) { _lockedUntil = 0; _loginAttempts = 0; rerender(n => n + 1); }
      else setRemaining(rem);
    }, 1000);
    return () => clearInterval(t);
  }, [_lockedUntil]);

  const isLocked = _lockedUntil > Date.now();

  const tryPassword = async () => {
    if (checking || isLocked || !pwd) return;
    setChecking(true);
    const hash = await hashPassword(pwd);
    // If no hash stored yet, fall back to comparing against hash of "1234"
    const target = passwordHash ?? await hashPassword("1234");
    const ok = hash === target;
    setChecking(false);
    if (ok) { _loginAttempts = 0; _lockedUntil = 0; onSuccess(); return; }
    _loginAttempts++;
    setPwd("");
    if (_loginAttempts >= 5) {
      _lockedUntil = Date.now() + 5 * 60 * 1000;
      setRemaining(300);
      setError("Too many failed attempts. Locked for 5 minutes.");
    } else {
      setError(`Incorrect password — ${5 - _loginAttempts} attempt${5 - _loginAttempts !== 1 ? "s" : ""} remaining.`);
    }
    rerender(n => n + 1);
  };

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.78)", zIndex: 2000, display: "flex", alignItems: "center", justifyContent: "center", padding: "20px" }}>
      <div style={{ background: T.white, borderRadius: "14px", padding: "40px 36px", width: "100%", maxWidth: "360px", textAlign: "center", boxShadow: "0 24px 64px rgba(0,0,0,0.45)" }}>
        <div style={{ fontFamily: "'Space Grotesk', system-ui, sans-serif", fontWeight: 700, fontSize: "20px", color: T.yellow, letterSpacing: "0.08em", textTransform: "uppercase", marginBottom: "2px" }}>Butler Tire</div>
        <div style={{ fontSize: "11px", color: T.gray, textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: "24px" }}>Admin Access</div>

        {(isDefault || !passwordHash) && !isLocked && (
          <div style={{ background: "#FEF3C7", border: "1px solid #FCD34D", borderRadius: "8px", padding: "8px 12px", marginBottom: "16px", fontSize: "12px", color: "#92400E", textAlign: "left" }}>
            <strong>Default password is 1234.</strong> Change it in Settings → Admin Security once you're in.
          </div>
        )}

        {isLocked ? (
          <div style={{ padding: "20px 0" }}>
            <div style={{ fontSize: "36px", marginBottom: "10px" }}>🔒</div>
            <div style={{ fontWeight: 700, fontSize: "15px", marginBottom: "6px", color: T.red }}>Too many attempts</div>
            <div style={{ fontSize: "13px", color: T.gray }}>Try again in <strong>{Math.floor(remaining / 60)}:{String(remaining % 60).padStart(2, "0")}</strong></div>
          </div>
        ) : (
          <>
            <div style={{ position: "relative", marginBottom: "10px" }}>
              <input type={showPwd ? "text" : "password"} placeholder="Enter password" value={pwd} autoFocus
                onChange={e => { setPwd(e.target.value); setError(""); }}
                onKeyDown={e => e.key === "Enter" && tryPassword()}
                style={{ ...inputStyle, paddingRight: "44px", fontSize: "15px" }} />
              <button onClick={() => setShowPwd(s => !s)}
                style={{ position: "absolute", right: "12px", top: "50%", transform: "translateY(-50%)", border: "none", background: "none", cursor: "pointer", fontSize: "16px", padding: "4px", color: T.gray }}>
                {showPwd ? "🙈" : "👁"}
              </button>
            </div>
            {error && <div style={{ color: T.red, fontSize: "12px", marginBottom: "12px", fontWeight: 500 }}>{error}</div>}
            <button onClick={tryPassword} disabled={!pwd || checking}
              style={{ ...(!pwd || checking ? btn.disabled : btn.primary), width: "100%", padding: "12px", fontSize: "15px", marginBottom: "12px" }}>
              {checking ? "Verifying…" : "Unlock Admin"}
            </button>
          </>
        )}
        <button onClick={onClose} style={{ background: "none", border: "none", cursor: "pointer", color: T.gray, fontSize: "13px", fontFamily: "inherit" }}>Cancel</button>
      </div>
    </div>
  );
}

// ── Booking flow ──────────────────────────────────────────────────────────────
function BookingFlow({ bookings, onBook, settings, isMobile }) {
  const [step, setStep]   = useState(1);
  const [sel, setSel]     = useState({ serviceIds: [], date: "", hour: null, bay: null });
  const [form, setForm]   = useState({ name: "", phone: "", email: "", make: "", model: "", year: "", notes: "" });
  const [confirmed, setConfirmed] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  const activeServices = getServices(settings);
  const selectedSvcs   = activeServices.filter(s => sel.serviceIds.includes(s.id));
  const totalDuration  = selectedSvcs.reduce((sum, s) => sum + s.duration, 0);
  const halfDay        = sel.date ? isHalfDay(sel.date) : false;
  const effectiveBays  = getEffectiveBays(settings, sel.date);
  const dayClose       = sel.date ? getDayHours(settings, sel.date).close : getCloseHour(settings);
  const slots = sel.date && sel.serviceIds.length > 0
    ? getSlots(bookings, sel.date, totalDuration, halfDay ? 12 : dayClose, effectiveBays, settings)
    : [];

  const formComplete = ["name","phone","email","make","model","year"].every(k => form[k].trim() !== "");

  const submit = async () => {
    setSubmitting(true);
    const needsApproval = settings.requireApproval || sel.serviceIds.includes("other");
    const booking = { id: genId(), ...form, serviceIds: sel.serviceIds, date: sel.date, hour: sel.hour, bay: sel.bay, status: needsApproval ? "pending" : "confirmed", createdAt: new Date().toISOString() };
    await onBook(booking);
    if (booking.status === "confirmed") await sendConfirmationEmail(booking, settings);
    setConfirmed(booking);
    setStep(4);
    setSubmitting(false);
  };

  const reset = () => {
    setStep(1);
    setSel({ serviceIds: [], date: "", hour: null, bay: null });
    setForm({ name: "", phone: "", email: "", make: "", model: "", year: "", notes: "" });
    setConfirmed(null);
  };

  if (step === 4 && confirmed) {
    const cSvcs   = getServices(settings).filter(s => (confirmed.serviceIds || [confirmed.serviceId]).includes(s.id));
    const csl     = getTimeSlots(settings).find(t => t.value === confirmed.hour);
    const pending = confirmed.status === "pending";
    return (
      <div style={{ maxWidth: "520px", margin: isMobile ? "24px auto" : "64px auto", padding: "0 16px" }}>
        <div style={{ background: T.white, border: `1px solid ${T.lightGray}`, borderRadius: "12px", padding: "40px", textAlign: "center" }}>
          <div style={{ width: "52px", height: "52px", background: pending ? "#F59E0B" : T.yellow, borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 20px", fontSize: "22px", color: T.white }}>
            {pending ? "⏳" : "✓"}
          </div>
          <h2 style={{ margin: "0 0 6px", fontFamily: "'Space Grotesk', system-ui, sans-serif", fontWeight: 700, fontSize: "22px" }}>
            {pending ? "Request received." : "You're all set."}
          </h2>
          <p style={{ margin: "0 0 24px", color: T.gray, fontSize: "14px" }}>
            {pending
              ? "We'll review your request and give you a call to confirm your appointment."
              : <>Booking ID: <code style={{ background: T.offWhite, padding: "2px 8px", borderRadius: "4px", fontWeight: 600 }}>{confirmed.id}</code></>}
          </p>
          <div style={{ background: T.offWhite, borderRadius: "8px", padding: "16px", textAlign: "left", marginBottom: "24px" }}>
            {[
              ["Services", cSvcs.map(s => s.name).join(", ")],
              ["Requested Date", confirmed.date ? displayDate(confirmed.date) : ""],
              ["Requested Time", csl?.label],
              ["Vehicle",        `${confirmed.year} ${confirmed.make} ${confirmed.model}`],
              ["Name",           confirmed.name],
              ["Contact",        confirmed.phone],
            ].map(([label, value]) => (
              <div key={label} style={{ display: "flex", justifyContent: "space-between", padding: "5px 0", fontSize: "13px", borderBottom: `1px solid ${T.lightGray}` }}>
                <span style={{ color: T.gray }}>{label}</span>
                <span style={{ fontWeight: 500, textAlign: "right", maxWidth: "60%" }}>{value}</span>
              </div>
            ))}
          </div>
          <button onClick={reset} style={btn.primary}>Book another appointment</button>
        </div>
      </div>
    );
  }

  return (
    <div style={{ maxWidth: "660px", margin: "0 auto", padding: isMobile ? "24px 16px" : "40px 24px" }}>
      {/* Progress */}
      <div style={{ display: "flex", gap: "8px", marginBottom: "40px" }}>
        {["Service", "Date & Time", "Your Info"].map((label, i) => (
          <div key={i} style={{ flex: 1 }}>
            <div style={{ height: "3px", borderRadius: "2px", marginBottom: "6px", background: step >= i + 1 ? T.yellow : T.lightGray }} />
            <span style={{ fontSize: "11px", fontWeight: step === i + 1 ? 700 : 400, color: step >= i + 1 ? T.black : "#bbb", textTransform: "uppercase", letterSpacing: "0.08em" }}>{label}</span>
          </div>
        ))}
      </div>

      {/* Step 1 – Service */}
      {step === 1 && (
        <>
          <h1 style={{ margin: "0 0 6px", fontFamily: "'Space Grotesk', system-ui, sans-serif", fontWeight: 700, fontSize: "26px" }}>What do you need done?</h1>
          <p style={{ margin: "0 0 24px", color: T.gray, fontSize: "14px" }}>Select everything you need — we'll block the right amount of time.</p>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: "10px", marginBottom: "20px" }}>
            {activeServices.map(sv => {
              const chosen = sel.serviceIds.includes(sv.id);
              return (
                <button key={sv.id} onClick={() => setSel(p => {
                  const ids = p.serviceIds.includes(sv.id)
                    ? p.serviceIds.filter(id => id !== sv.id)
                    : [...p.serviceIds, sv.id];
                  return { ...p, serviceIds: ids, hour: null, bay: null };
                })} style={{
                  padding: "14px 16px", border: `2px solid ${chosen ? T.yellow : T.lightGray}`,
                  borderRadius: "8px", background: chosen ? T.yellowBg : T.white,
                  textAlign: "left", cursor: "pointer", fontFamily: "inherit", position: "relative",
                }}>
                  {chosen && (
                    <div style={{ position: "absolute", top: "10px", right: "10px", width: "18px", height: "18px", background: T.yellow, borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center", fontSize: "10px", color: T.white, fontWeight: 700 }}>✓</div>
                  )}
                  <div style={{ fontWeight: 600, fontSize: "14px", marginBottom: "3px", paddingRight: chosen ? "22px" : "0" }}>{sv.name}</div>
                  <div style={{ fontSize: "12px", color: T.gray, marginBottom: "8px", lineHeight: "1.4" }}>{sv.desc}</div>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <span style={{ fontSize: "11px", color: "#aaa", fontFamily: "monospace" }}>{sv.duration}h est.</span>
                    <span style={{ fontSize: "12px", fontWeight: 600 }}>{sv.price}</span>
                  </div>
                </button>
              );
            })}
          </div>
          {sel.serviceIds.length > 0 && (
            <div style={{ background: T.yellowBg, border: `1px solid ${T.yellow}22`, borderRadius: "8px", padding: "10px 14px", marginBottom: "20px", fontSize: "13px", color: T.black }}>
              <strong>{sel.serviceIds.length} service{sel.serviceIds.length > 1 ? "s" : ""} selected</strong>
              {" · "}~{totalDuration}h total
              {" · "}
              <span style={{ color: T.gray }}>{selectedSvcs.map(s => s.name).join(", ")}</span>
            </div>
          )}

          <div style={{ background: T.offWhite, border: `1px solid ${T.lightGray}`, borderRadius: "8px", padding: "10px 14px", marginBottom: "20px", fontSize: "12px", color: T.gray, lineHeight: "1.5" }}>
            ⓘ All prices shown are estimates and subject to change based on vehicle and parts required. Applicable taxes are not included in the prices listed.
          </div>
          <div style={{ display: "flex", justifyContent: "flex-end" }}>
            <button onClick={() => setStep(2)} disabled={sel.serviceIds.length === 0} style={sel.serviceIds.length > 0 ? btn.primary : btn.disabled}>Next →</button>
          </div>
        </>
      )}

      {/* Step 2 – Date & Time */}
      {step === 2 && (
        <>
          <h1 style={{ margin: "0 0 6px", fontFamily: "'Space Grotesk', system-ui, sans-serif", fontWeight: 700, fontSize: "26px" }}>Pick a date and time</h1>
          <p style={{ margin: "0 0 20px", color: T.gray, fontSize: "14px" }}>Open Monday – Friday, 8 AM – 5 PM.</p>

          {/* Next available banner */}
          {(() => {
            const next = findNextAvailable(bookings, settings, totalDuration);
            if (!next) return null;
            const isSelected = sel.date === next.date && sel.hour === next.slot.value;
            return (
              <div style={{ background: isSelected ? T.yellowBg : "#F0F4FF", border: `2px solid ${isSelected ? T.yellow : "#B8CCFF"}`, borderRadius: "10px", padding: "14px 16px", marginBottom: "24px", display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: "10px" }}>
                <div>
                  <div style={{ fontSize: "11px", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.08em", color: isSelected ? T.yellow : "#4A72D4", marginBottom: "4px" }}>
                    {isSelected ? "✓ Selected" : "⚡ Next Available"}
                  </div>
                  <div style={{ fontWeight: 700, fontSize: "16px", color: T.black }}>{displayDate(next.date)}</div>
                  <div style={{ fontSize: "13px", color: T.gray, marginTop: "2px" }}>{next.slot.label} · ~{totalDuration}h</div>
                </div>
                {!isSelected && (
                  <button onClick={() => setSel(p => ({ ...p, date: next.date, hour: next.slot.value, bay: next.slot.freeBay }))}
                    style={{ background: T.yellow, color: T.white, border: "none", borderRadius: "7px", padding: "10px 20px", fontSize: "14px", fontWeight: 700, cursor: "pointer", fontFamily: "inherit", whiteSpace: "nowrap" }}>
                    Book This Slot
                  </button>
                )}
              </div>
            );
          })()}

          <label style={labelStyle}>Date</label>
          <input type="date" min={minDate()} max={getMaxDate(settings)} value={sel.date}
            onChange={e => {
              const val = e.target.value;
              if (!val || isWeekendClosed(val, settings) || isDateClosed(val, settings)) return;
              setSel(p => ({ ...p, date: val, hour: null, bay: null }));
            }}
            style={{ ...inputStyle, display: "block", width: "200px", marginBottom: "24px" }} />

          {halfDay && (
            <div style={{ padding: "10px 14px", background: "#FEF3C7", border: "1px solid #FCD34D", borderRadius: "8px", marginBottom: "16px", fontSize: "13px", color: "#92400E", fontWeight: 500 }}>
              ⚠ We close at noon on this date — only morning slots are available.
            </div>
          )}

          {sel.date && (
            <>
              <label style={labelStyle}>Available Times</label>
              {slots.every(sl => !sl.available) ? (
                <div style={{ padding: "14px 16px", background: "#FFF0EF", border: "1px solid #FFD0CC", borderRadius: "8px", color: T.red, fontSize: "14px" }}>
                  No open slots on this date — try another day.
                </div>
              ) : (
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(90px, 1fr))", gap: "8px" }}>
                  {slots.map(sl => (
                    <button key={sl.value} disabled={!sl.available}
                      onClick={() => setSel(p => ({ ...p, hour: sl.value, bay: sl.freeBay }))}
                      style={{
                        padding: "10px 4px", fontSize: "13px", fontFamily: "inherit",
                        fontWeight: sel.hour === sl.value ? 700 : 400,
                        border: `2px solid ${sel.hour === sl.value ? T.yellow : sl.available ? T.lightGray : "#F0F0F0"}`,
                        borderRadius: "6px",
                        background: sel.hour === sl.value ? T.yellowBg : sl.available ? T.white : "#F8F8F8",
                        color: sl.available ? T.black : "#ccc",
                        cursor: sl.available ? "pointer" : "not-allowed",
                      }}>{sl.label}</button>
                  ))}
                </div>
              )}
            </>
          )}

          <div style={{ marginTop: "32px", display: "flex", justifyContent: "space-between" }}>
            <button onClick={() => setStep(1)} style={btn.ghost}>← Back</button>
            <button onClick={() => setStep(3)} disabled={!sel.hour} style={sel.hour ? btn.primary : btn.disabled}>Next →</button>
          </div>
        </>
      )}

      {/* Step 3 – Info */}
      {step === 3 && (
        <>
          <h1 style={{ margin: "0 0 6px", fontFamily: "'Space Grotesk', system-ui, sans-serif", fontWeight: 700, fontSize: "26px" }}>Your details</h1>
          <p style={{ margin: "0 0 24px", color: T.gray, fontSize: "14px" }}>Last step. Fill this in and you're done.</p>

          <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr" : "1fr 1fr", gap: "14px", marginBottom: "16px" }}>
            <div>
              <label style={labelStyle}>Full Name</label>
              <input style={inputStyle} placeholder="Jane Smith" value={form.name} onChange={e => setForm(p => ({ ...p, name: e.target.value }))} />
            </div>
            <div>
              <label style={labelStyle}>Phone Number</label>
              <input style={inputStyle} placeholder="(555) 000-0000" value={form.phone} onChange={e => setForm(p => ({ ...p, phone: e.target.value }))} />
            </div>
            <div style={{ gridColumn: "1 / -1" }}>
              <label style={labelStyle}>Email Address</label>
              <input type="email" style={inputStyle} placeholder="jane@email.com" value={form.email} onChange={e => setForm(p => ({ ...p, email: e.target.value }))} />
            </div>
          </div>

          <div style={{ background: T.offWhite, border: `1px solid ${T.lightGray}`, borderRadius: "8px", padding: "16px", marginBottom: "20px" }}>
            <p style={sectionLabel}>Vehicle</p>
            <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr 1fr" : "1fr 1fr 90px", gap: "12px" }}>
              {[["make", "Make", "Toyota"], ["model", "Model", "Camry"], ["year", "Year", "2019"]].map(([key, label, ph]) => (
                <div key={key}>
                  <label style={labelStyle}>{label}</label>
                  <input style={inputStyle} placeholder={ph} maxLength={key === "year" ? 4 : undefined} value={form[key]} onChange={e => setForm(p => ({ ...p, [key]: e.target.value }))} />
                </div>
              ))}
            </div>
          </div>

          <div style={{ marginBottom: "20px" }}>
            <label style={labelStyle}>
              Additional Comments
              <span style={{ fontWeight: 400, textTransform: "none", letterSpacing: 0, color: T.gray, marginLeft: "6px" }}>(optional)</span>
            </label>
            <textarea
              placeholder="Anything we should know — specific concerns, noises, previous work done, etc."
              value={form.notes}
              onChange={e => setForm(p => ({ ...p, notes: e.target.value }))}
              style={{ ...inputStyle, display: "block", resize: "vertical", minHeight: "80px", lineHeight: "1.5" }}
            />
          </div>

          {/* Summary */}
          <div style={{ background: T.white, border: `1px solid ${T.lightGray}`, borderRadius: "8px", padding: "14px 16px", marginBottom: "10px" }}>
            <p style={sectionLabel}>Booking Summary</p>
            {[
              ["Services", selectedSvcs.map(s => s.name).join(", ")],
              ["Date",     sel.date ? displayDate(sel.date) : ""],
              ["Time",     getTimeSlots(settings).find(t => t.value === sel.hour)?.label],
              ["Duration", `~${totalDuration}h estimated`],
            ].map(([label, value]) => (
              <div key={label} style={{ display: "flex", justifyContent: "space-between", padding: "4px 0", fontSize: "13px", borderBottom: `1px solid ${T.offWhite}` }}>
                <span style={{ color: T.gray, flexShrink: 0 }}>{label}</span>
                <span style={{ fontWeight: 500, textAlign: "right", marginLeft: "12px" }}>{value}</span>
              </div>
            ))}
          </div>
          <div style={{ fontSize: "11px", color: T.gray, marginBottom: "20px", lineHeight: "1.6", padding: "0 2px" }}>
            ⓘ All prices are estimates and subject to change based on your vehicle and parts required. Applicable taxes are not included in the prices shown.
          </div>

          <div style={{ display: "flex", justifyContent: "space-between" }}>
            <button onClick={() => setStep(2)} style={btn.ghost}>← Back</button>
            <button onClick={submit} disabled={!formComplete || submitting} style={!formComplete || submitting ? btn.disabled : btn.primary}>
              {submitting ? "Booking…" : "Confirm Booking"}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function PasswordChangeSection({ passwordHash, onSave }) {
  const [curPwd,  setCurPwd]  = useState("");
  const [newPwd,  setNewPwd]  = useState("");
  const [confPwd, setConfPwd] = useState("");
  const [show,    setShow]    = useState(false);
  const [checking,setChecking]= useState(false);
  const [error,   setError]   = useState("");
  const [saved,   setSaved]   = useState(false);

  function strength(pwd) {
    if (!pwd) return null;
    if (pwd.length < 8) return { level: 0, label: "Too short — min 8 characters", color: "#bbb" };
    const checks = [/[A-Z]/.test(pwd), /[a-z]/.test(pwd), /[0-9]/.test(pwd), /[^A-Za-z0-9]/.test(pwd)];
    const score = checks.filter(Boolean).length;
    if (score <= 2) return { level: 1, label: "Weak",   color: T.red };
    if (score === 3) return { level: 2, label: "Good",   color: "#F59E0B" };
    return              { level: 3, label: "Strong", color: "#2D8A5A" };
  }
  const str = strength(newPwd);

  const save = async () => {
    setError(""); setSaved(false);
    if (!curPwd || !newPwd || !confPwd) { setError("All fields are required."); return; }
    if (newPwd.length < 8)             { setError("New password must be at least 8 characters."); return; }
    if (newPwd !== confPwd)            { setError("New passwords don't match."); return; }
    setChecking(true);
    const curHash = await hashPassword(curPwd);
    if (curHash !== passwordHash) { setChecking(false); setError("Current password is incorrect."); return; }
    const newHash = await hashPassword(newPwd);
    setChecking(false);
    onSave(newHash);
    setCurPwd(""); setNewPwd(""); setConfPwd("");
    setSaved(true); setTimeout(() => setSaved(false), 3000);
  };

  const t = show ? "text" : "password";
  return (
    <div style={{ marginTop: "12px", maxWidth: "400px" }}>
      <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
        <div>
          <label style={labelStyle}>Current Password</label>
          <input type={t} value={curPwd} onChange={e => { setCurPwd(e.target.value); setError(""); }} style={inputStyle} placeholder="Enter current password" />
        </div>
        <div>
          <label style={labelStyle}>New Password</label>
          <input type={t} value={newPwd} onChange={e => { setNewPwd(e.target.value); setError(""); }} style={inputStyle} placeholder="Min 8 characters" />
          {str && (
            <div style={{ marginTop: "6px" }}>
              <div style={{ display: "flex", gap: "4px", marginBottom: "3px" }}>
                {[1,2,3].map(l => <div key={l} style={{ flex: 1, height: "3px", borderRadius: "2px", background: str.level >= l ? str.color : T.lightGray }} />)}
              </div>
              <span style={{ fontSize: "11px", color: str.color, fontWeight: 600 }}>{str.label}</span>
            </div>
          )}
        </div>
        <div>
          <label style={labelStyle}>Confirm New Password</label>
          <input type={t} value={confPwd} onChange={e => { setConfPwd(e.target.value); setError(""); }} style={inputStyle} placeholder="Repeat new password" onKeyDown={e => e.key === "Enter" && save()} />
        </div>
        {error && <div style={{ fontSize: "12px", color: T.red, fontWeight: 500 }}>{error}</div>}
        {saved && <div style={{ fontSize: "12px", color: "#2D8A5A", fontWeight: 600 }}>✓ Password updated successfully.</div>}
        <div style={{ display: "flex", gap: "8px" }}>
          <button onClick={save} disabled={!curPwd || !newPwd || !confPwd || checking}
            style={{ ...(!curPwd || !newPwd || !confPwd || checking ? btn.disabled : btn.primary), padding: "10px 20px" }}>
            {checking ? "Verifying…" : "Update Password"}
          </button>
          <button onClick={() => setShow(s => !s)} style={{ ...btn.ghost, padding: "10px 14px", fontSize: "14px" }}>{show ? "🙈" : "👁"}</button>
        </div>
        <div style={{ fontSize: "12px", color: T.gray }}>Use uppercase, lowercase, numbers, and symbols for a strong password.</div>
      </div>
    </div>
  );
}

// ── Settings Panel ────────────────────────────────────────────────────────────
function Section({ title, subtitle, children }) {
  return (
    <div style={{ background: T.white, border: `1px solid ${T.lightGray}`, borderRadius: "8px", padding: "20px", marginBottom: "14px" }}>
      <div style={{ fontWeight: 700, fontSize: "14px", marginBottom: "3px" }}>{title}</div>
      {subtitle && <div style={{ fontSize: "12px", color: T.gray, marginBottom: "2px" }}>{subtitle}</div>}
      {children}
    </div>
  );
}

function SettingsPanel({ settings, onUpdate }) {
  const [localSvcs, setLocalSvcs]   = useState(() => JSON.parse(JSON.stringify(getServices(settings))));
  const [svcsDirty, setSvcsDirty]   = useState(false);
  const [newHoliday, setNewHoliday] = useState({ date: "", label: "" });

  const setSvc    = (id, field, val) => { setLocalSvcs(p => p.map(s => s.id === id ? { ...s, [field]: val } : s)); setSvcsDirty(true); };
  const addSvc    = () => { setLocalSvcs(p => [...p, { id: `svc-${Date.now()}`, name: "New Service", duration: 1, price: "Quote", desc: "" }]); setSvcsDirty(true); };
  const removeSvc = (id) => { setLocalSvcs(p => p.filter(s => s.id !== id)); setSvcsDirty(true); };
  const saveSvcs  = () => { onUpdate({ services: localSvcs }); setSvcsDirty(false); };

  const curSlots   = getSlotHours(settings);
  const toggleSlot = (h) => { const next = curSlots.includes(h) ? curSlots.filter(x => x !== h) : [...curSlots, h].sort((a, b) => a - b); if (next.length) onUpdate({ slotHours: next }); };

  const addHoliday    = () => { if (!newHoliday.date) return; onUpdate({ customHolidays: [...(settings.customHolidays || []), { ...newHoliday }] }); setNewHoliday({ date: "", label: "" }); };
  const removeHoliday = (date) => onUpdate({ customHolidays: (settings.customHolidays || []).filter(h => h.date !== date) });

  const hourOptions = Array.from({ length: 13 }, (_, i) => i + 6); // 6am–6pm

  return (
    <div style={{ maxWidth: "820px" }}>

      {/* ── Services ── */}
      <Section title="Services" subtitle="Edit names, descriptions, prices, and time estimates. Hit Save when done.">
        <div style={{ display: "flex", flexDirection: "column", gap: "8px", margin: "14px 0 10px" }}>
          {localSvcs.map(sv => (
            <div key={sv.id} style={{ display: "grid", gridTemplateColumns: "1fr 1.4fr 58px 130px 36px", gap: "8px", alignItems: "end", background: T.offWhite, padding: "10px 12px", borderRadius: "8px", border: `1px solid ${T.lightGray}` }}>
              <div><label style={labelStyle}>Name</label><input value={sv.name} onChange={e => setSvc(sv.id, "name", e.target.value)} style={inputStyle} /></div>
              <div><label style={labelStyle}>Description</label><input value={sv.desc} onChange={e => setSvc(sv.id, "desc", e.target.value)} style={inputStyle} placeholder="Short description" /></div>
              <div><label style={labelStyle}>Hours</label><input type="number" min="1" max="8" value={sv.duration} onChange={e => setSvc(sv.id, "duration", Math.max(1, parseInt(e.target.value) || 1))} style={inputStyle} /></div>
              <div><label style={labelStyle}>Price</label><input value={sv.price} onChange={e => setSvc(sv.id, "price", e.target.value)} style={inputStyle} placeholder="$45 or Quote" /></div>
              <button onClick={() => removeSvc(sv.id)} style={{ width: "36px", height: "38px", border: `1px solid ${T.lightGray}`, borderRadius: "6px", background: T.white, cursor: "pointer", color: T.red, fontSize: "18px", display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "inherit" }}>×</button>
            </div>
          ))}
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <button onClick={addSvc} style={{ ...btn.ghost, fontSize: "13px", padding: "7px 16px" }}>+ Add Service</button>
          {svcsDirty && <button onClick={saveSvcs} style={{ ...btn.primary, padding: "7px 18px", fontSize: "13px" }}>Save Services</button>}
        </div>
      </Section>

      {/* ── Weekend Hours ── */}
      <Section title="Weekend Hours" subtitle="By default the shop is closed Saturday and Sunday. Enable either day to allow customers to book on those days.">
        <div style={{ display: "flex", gap: "12px", marginTop: "14px", flexWrap: "wrap" }}>
          {[["openSaturday", "Open Saturdays"], ["openSunday", "Open Sundays"]].map(([key, label]) => {
            const on = settings[key] ?? false;
            return (
              <button key={key} onClick={() => onUpdate({ [key]: !on })} style={{
                display: "flex", alignItems: "center", gap: "10px",
                padding: "12px 20px", border: `2px solid ${on ? T.yellow : T.lightGray}`,
                borderRadius: "8px", background: on ? T.yellowBg : T.white,
                cursor: "pointer", fontFamily: "inherit", fontSize: "14px",
                fontWeight: on ? 700 : 400, color: on ? T.yellow : T.black,
              }}>
                <span style={{ width: "20px", height: "20px", borderRadius: "4px", border: `2px solid ${on ? T.yellow : T.lightGray}`, background: on ? T.yellow : T.white, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, fontSize: "13px", color: T.white, fontWeight: 700 }}>
                  {on ? "✓" : ""}
                </span>
                {label}
              </button>
            );
          })}
        </div>
        <div style={{ fontSize: "12px", color: T.gray, marginTop: "10px" }}>
          Changes take effect immediately — no restart needed.
        </div>
      </Section>

      {/* ── Appointment Slots ── */}
      <Section title="Appointment Slots" subtitle="Choose which hours customers can book. Tap to toggle.">
        <div style={{ display: "flex", flexWrap: "wrap", gap: "8px", marginTop: "12px" }}>
          {Array.from({ length: 11 }, (_, i) => i + 6).map(h => {
            const on = curSlots.includes(h);
            return (
              <button key={h} onClick={() => toggleSlot(h)} style={{ padding: "8px 14px", border: `2px solid ${on ? T.yellow : T.lightGray}`, borderRadius: "6px", background: on ? T.yellowBg : T.white, fontWeight: on ? 700 : 400, cursor: "pointer", fontFamily: "inherit", fontSize: "13px", color: on ? T.yellow : T.black }}>
                {fmtHour(h)}
              </button>
            );
          })}
        </div>
        <div style={{ fontSize: "12px", color: T.gray, marginTop: "8px" }}>Active slots: {curSlots.map(fmtHour).join(", ")}</div>
      </Section>

      {/* ── Business Hours ── */}
      <Section title="Business Hours" subtitle="Set opening and closing times for each day independently.">
        {(() => {
          const activeDays = [
            { key: "monday",    label: "Monday"    },
            { key: "tuesday",   label: "Tuesday"   },
            { key: "wednesday", label: "Wednesday" },
            { key: "thursday",  label: "Thursday"  },
            { key: "friday",    label: "Friday"    },
            ...(settings.openSaturday ? [{ key: "saturday", label: "Saturday" }] : []),
            ...(settings.openSunday   ? [{ key: "sunday",   label: "Sunday"   }] : []),
          ];
          const getDH = (key) => settings.dayHours?.[key] ?? { open: settings.openHour ?? 8, close: settings.closeHour ?? 17 };
          const setDH = (key, field, val) => onUpdate({ dayHours: { ...settings.dayHours, [key]: { ...getDH(key), [field]: parseInt(val) } } });
          return (
            <div style={{ marginTop: "12px" }}>
              <div style={{ display: "grid", gridTemplateColumns: "130px 1fr 1fr", gap: "6px 12px", alignItems: "center" }}>
                <div />
                <div style={labelStyle}>Opens at</div>
                <div style={labelStyle}>Closes at</div>
                {activeDays.map(({ key, label }) => (
                  [
                    <div key={key + "-label"} style={{ fontWeight: 500, fontSize: "13px", color: T.black }}>{label}</div>,
                    <select key={key + "-open"} value={getDH(key).open} onChange={e => setDH(key, "open", e.target.value)}
                      style={{ ...inputStyle, cursor: "pointer" }}>
                      {hourOptions.map(h => <option key={h} value={h}>{fmtHour(h)}</option>)}
                    </select>,
                    <select key={key + "-close"} value={getDH(key).close} onChange={e => setDH(key, "close", e.target.value)}
                      style={{ ...inputStyle, cursor: "pointer" }}>
                      {hourOptions.map(h => <option key={h} value={h}>{fmtHour(h)}</option>)}
                    </select>,
                  ]
                ))}
              </div>
              {!settings.openSaturday && !settings.openSunday && (
                <div style={{ fontSize: "12px", color: T.gray, marginTop: "10px" }}>Enable Saturday or Sunday in Weekend Hours above to configure those days.</div>
              )}
            </div>
          );
        })()}
      </Section>

      {/* ── Booking Window ── */}
      <Section title="Booking Window" subtitle="How far in advance customers can book.">
        <div style={{ display: "flex", gap: "8px", marginTop: "12px", flexWrap: "wrap" }}>
          {[1, 2, 3, 4, 6].map(n => {
            const active = (settings.bookingMonths ?? 2) === n;
            return (
              <button key={n} onClick={() => onUpdate({ bookingMonths: n })} style={{ padding: "8px 18px", border: `2px solid ${active ? T.yellow : T.lightGray}`, borderRadius: "6px", background: active ? T.yellowBg : T.white, fontWeight: active ? 700 : 400, cursor: "pointer", fontFamily: "inherit", fontSize: "13px", color: active ? T.yellow : T.black }}>
                {n} {n === 1 ? "month" : "months"}
              </button>
            );
          })}
        </div>
      </Section>

      {/* ── Custom Holidays ── */}
      <Section title="Custom Shop Closures" subtitle="Days you're closed beyond the standard holidays. Easter, Memorial Day, July 4th, Labor Day, Thanksgiving, Christmas, and New Year's are already blocked automatically.">
        <div style={{ display: "flex", gap: "8px", marginTop: "12px", flexWrap: "wrap", alignItems: "flex-end" }}>
          <div><label style={labelStyle}>Date</label><input type="date" value={newHoliday.date} onChange={e => setNewHoliday(p => ({ ...p, date: e.target.value }))} style={{ ...inputStyle, width: "160px" }} /></div>
          <div style={{ flex: 1, minWidth: "160px" }}><label style={labelStyle}>Reason (optional)</label><input value={newHoliday.label} onChange={e => setNewHoliday(p => ({ ...p, label: e.target.value }))} placeholder="e.g. Owner vacation" style={inputStyle} /></div>
          <button disabled={!newHoliday.date} onClick={addHoliday} style={newHoliday.date ? { ...btn.primary, padding: "10px 16px" } : { ...btn.disabled, padding: "10px 16px" }}>Add</button>
        </div>
        {(settings.customHolidays || []).length === 0
          ? <div style={{ fontSize: "12px", color: T.gray, fontStyle: "italic", marginTop: "12px" }}>None added yet.</div>
          : (
            <div style={{ display: "flex", flexDirection: "column", gap: "6px", marginTop: "12px" }}>
              {[...(settings.customHolidays || [])].sort((a, b) => a.date.localeCompare(b.date)).map(c => (
                <div key={c.date} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", background: T.offWhite, borderRadius: "6px", padding: "8px 12px" }}>
                  <span style={{ fontSize: "13px" }}><strong>{displayDate(c.date)}</strong>{c.label && <span style={{ color: T.gray, marginLeft: "8px" }}>— {c.label}</span>}</span>
                  <button onClick={() => removeHoliday(c.date)} style={{ border: "none", background: "none", cursor: "pointer", color: T.gray, fontSize: "18px", padding: "0 4px", lineHeight: 1 }}>×</button>
                </div>
              ))}
            </div>
          )}
      </Section>

      {/* ── Email Notifications ── */}
      <Section title="Email Confirmations" subtitle="Automatically email customers when their appointment is confirmed. Requires a free EmailJS account (emailjs.com) — takes about 5 minutes to set up.">
        <div style={{ marginTop: "14px", display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "16px" }}>
          <div>
            <div style={{ fontWeight: 600, fontSize: "14px", marginBottom: "2px" }}>Send confirmation emails</div>
            <div style={{ fontSize: "12px", color: T.gray }}>Currently: <strong>{settings.emailjs?.enabled ? "On" : "Off"}</strong></div>
          </div>
          <button onClick={() => onUpdate({ emailjs: { ...settings.emailjs, enabled: !settings.emailjs?.enabled } })} style={{
            width: "52px", height: "28px", borderRadius: "14px", border: "none", cursor: "pointer",
            background: settings.emailjs?.enabled ? T.yellow : T.lightGray, position: "relative", flexShrink: 0,
          }}>
            <span style={{ position: "absolute", top: "3px", width: "22px", height: "22px", borderRadius: "50%", background: T.white, boxShadow: "0 1px 3px rgba(0,0,0,0.2)", left: settings.emailjs?.enabled ? "27px" : "3px", transition: "left 0.2s" }} />
          </button>
        </div>
        {settings.emailjs?.enabled && (
          <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
            {[["serviceId","EmailJS Service ID","service_xxxxx"],["templateId","Template ID","template_xxxxx"],["publicKey","Public Key","xxxxxxxxxxxxxxx"]].map(([key, label, ph]) => (
              <div key={key}>
                <label style={labelStyle}>{label}</label>
                <input value={settings.emailjs?.[key] || ""} placeholder={ph}
                  onChange={e => onUpdate({ emailjs: { ...settings.emailjs, [key]: e.target.value } })}
                  style={inputStyle} />
              </div>
            ))}
            <div style={{ background: T.offWhite, borderRadius: "8px", padding: "12px 14px", fontSize: "12px", color: T.gray, lineHeight: "1.6" }}>
              <strong>Setup steps:</strong><br />
              1. Go to <strong>emailjs.com</strong> and create a free account<br />
              2. Add an Email Service (Gmail works great)<br />
              3. Create an Email Template with these variables:<br />
              <code style={{ background: T.white, padding: "2px 4px", borderRadius: "3px", fontSize: "11px" }}>{"{{to_name}} {{to_email}} {{services}} {{date}} {{time}} {{vehicle}} {{shop_name}} {{shop_phone}}"}</code><br />
              4. Copy your Service ID, Template ID, and Public Key above
            </div>
          </div>
        )}
      </Section>

      {/* ── Approval ── */}
      <Section title="Appointment Approval" subtitle="When enabled, every new booking goes into a pending queue for you to approve before it's confirmed on the schedule. When off, only 'Other' requests need approval.">
        <div style={{ marginTop: "14px", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div>
            <div style={{ fontWeight: 600, fontSize: "14px", marginBottom: "2px" }}>Require approval for all bookings</div>
            <div style={{ fontSize: "12px", color: T.gray }}>Currently: <strong>{settings.requireApproval ? "On — all bookings need approval" : "Off — only 'Other' needs approval"}</strong></div>
          </div>
          <button onClick={() => onUpdate({ requireApproval: !settings.requireApproval })} style={{
            width: "52px", height: "28px", borderRadius: "14px", border: "none", cursor: "pointer",
            background: settings.requireApproval ? T.yellow : T.lightGray,
            position: "relative", transition: "background 0.2s", flexShrink: 0,
          }}>
            <span style={{
              position: "absolute", top: "3px", width: "22px", height: "22px", borderRadius: "50%",
              background: T.white, boxShadow: "0 1px 3px rgba(0,0,0,0.2)",
              left: settings.requireApproval ? "27px" : "3px", transition: "left 0.2s",
            }} />
          </button>
        </div>
      </Section>

      {/* ── Admin Security ── */}
      <Section title="Admin Security" subtitle="Your password is hashed with SHA-256 — never stored in plain text. Lockouts only affect the device where wrong attempts were made, so customers can't lock you out on your own computer.">
        <PasswordChangeSection
          passwordHash={settings.adminPasswordHash}
          onSave={hash => onUpdate({ adminPasswordHash: hash, adminPasswordChanged: true })}
        />
      </Section>
    </div>
  );
}

// ── Revenue Report ────────────────────────────────────────────────────────────
function RevenueReport({ bookings, settings }) {
  const [period, setPeriod] = useState("all");
  const svcs = getServices(settings);

  const parsePrice = (priceStr) => {
    if (!priceStr || /quote/i.test(priceStr)) return null;
    const m = priceStr.match(/[\d.]+/);
    return m ? parseFloat(m[0]) : null;
  };

  const fromDate = (() => {
    if (period === "month") { const d = new Date(); d.setMonth(d.getMonth() - 1); return toDateStr(d); }
    if (period === "year")  { const d = new Date(); d.setFullYear(d.getFullYear() - 1); return toDateStr(d); }
    return null;
  })();

  const confirmed = bookings.filter(b => (b.status === "confirmed" || b.status === "completed") && (!fromDate || b.date >= fromDate));

  // Build per-service stats
  const svcStats = {};
  for (const b of confirmed) {
    const ids = b.serviceIds || (b.serviceId ? [b.serviceId] : []);
    for (const id of ids) {
      const svc = svcs.find(s => s.id === id);
      if (!svc) continue;
      if (!svcStats[id]) svcStats[id] = { name: svc.name, count: 0, revenue: 0, priced: false };
      svcStats[id].count++;
      const price = parsePrice(svc.price);
      if (price !== null) { svcStats[id].revenue += price; svcStats[id].priced = true; }
    }
  }

  const totalRevenue = Object.values(svcStats).reduce((s, v) => s + v.revenue, 0);
  const totalJobs    = confirmed.length;
  const unquotedJobs = Object.values(svcStats).filter(s => !s.priced).reduce((a, s) => a + s.count, 0);

  // Monthly trend — all time regardless of period filter
  const monthMap = {};
  for (const b of bookings.filter(bk => bk.status === "confirmed" || bk.status === "completed")) {
    const m = b.date?.slice(0, 7); if (!m) continue;
    if (!monthMap[m]) monthMap[m] = { bookings: 0, revenue: 0 };
    monthMap[m].bookings++;
    const ids = b.serviceIds || (b.serviceId ? [b.serviceId] : []);
    for (const id of ids) {
      const price = parsePrice(svcs.find(s => s.id === id)?.price);
      if (price) monthMap[m].revenue += price;
    }
  }
  const monthlyTrend = Object.entries(monthMap)
    .sort(([a], [b]) => a.localeCompare(b)).slice(-8)
    .map(([k, v]) => ({ label: new Date(k + "-15").toLocaleDateString("en-US", { month: "short", year: "2-digit" }), ...v, revenue: Math.round(v.revenue) }));

  const serviceData = Object.values(svcStats).sort((a, b) => b.count - a.count);
  const COLORS = [T.yellow, "#4A72D4", "#2D8A5A", "#F59E0B", "#8B5CF6", "#EC4899"];
  const fmt = (n) => "$" + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  return (
    <div style={{ marginTop: "32px", paddingTop: "28px", borderTop: `2px solid ${T.lightGray}` }}>
      {/* Header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "20px", flexWrap: "wrap", gap: "10px" }}>
        <div>
          <h2 style={{ margin: "0 0 3px", fontFamily: "'Space Grotesk', system-ui, sans-serif", fontWeight: 700, fontSize: "20px" }}>Revenue Overview</h2>
          <p style={{ margin: 0, fontSize: "12px", color: T.gray }}>Based on list prices. "Quote" jobs are counted but excluded from dollar totals.</p>
        </div>
        <div style={{ display: "flex", gap: "3px", background: "#EBEBEB", borderRadius: "7px", padding: "3px" }}>
          {[["all","All Time"],["year","Last Year"],["month","Last 30 Days"]].map(([v,l]) => (
            <button key={v} onClick={() => setPeriod(v)} style={{
              padding: "5px 12px", border: "none", borderRadius: "5px", cursor: "pointer",
              fontSize: "12px", fontWeight: period === v ? 600 : 400, fontFamily: "inherit",
              background: period === v ? T.white : "transparent", color: period === v ? T.black : T.gray,
              boxShadow: period === v ? "0 1px 3px rgba(0,0,0,0.1)" : "none",
            }}>{l}</button>
          ))}
        </div>
      </div>

      {confirmed.length === 0 ? (
        <div style={{ background: T.white, border: `1px solid ${T.lightGray}`, borderRadius: "8px", padding: "40px", textAlign: "center", color: T.gray, fontSize: "14px" }}>
          No confirmed bookings in this period yet.
        </div>
      ) : (
        <>
          {/* Stat cards */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: "10px", marginBottom: "16px" }}>
            {[
              { label: "Est. Revenue",  value: fmt(totalRevenue), note: unquotedJobs > 0 ? `+ ${unquotedJobs} quoted job${unquotedJobs !== 1 ? "s" : ""} not included` : "From all priced services" },
              { label: "Confirmed Jobs", value: totalJobs,        note: "Total appointments" },
              { label: "Avg per Job",    value: totalJobs > 0 ? fmt(totalRevenue / totalJobs) : "$0.00", note: "Priced services only" },
            ].map((s, i) => (
              <div key={i} style={{ background: T.white, border: `1px solid ${T.lightGray}`, borderRadius: "8px", padding: "16px" }}>
                <div style={{ fontFamily: "'Space Grotesk', system-ui, sans-serif", fontWeight: 700, fontSize: "26px", lineHeight: 1, marginBottom: "4px" }}>{s.value}</div>
                <div style={{ fontWeight: 600, fontSize: "13px", marginBottom: "2px" }}>{s.label}</div>
                <div style={{ fontSize: "11px", color: T.gray }}>{s.note}</div>
              </div>
            ))}
          </div>

          {/* Charts */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: "12px", marginBottom: "16px" }}>
            {/* Monthly trend */}
            <div style={{ background: T.white, border: `1px solid ${T.lightGray}`, borderRadius: "8px", padding: "16px" }}>
              <p style={sectionLabel}>Monthly Bookings</p>
              {monthlyTrend.length < 2 ? (
                <div style={{ fontSize: "12px", color: T.gray, fontStyle: "italic", paddingTop: "8px" }}>Need more bookings to show a trend.</div>
              ) : (
                <ResponsiveContainer width="100%" height={160}>
                  <BarChart data={monthlyTrend} margin={{ top: 4, right: 4, bottom: 0, left: -24 }}>
                    <XAxis dataKey="label" tick={{ fontSize: 10 }} />
                    <YAxis tick={{ fontSize: 10 }} allowDecimals={false} />
                    <Tooltip formatter={(v) => [v, "Bookings"]} />
                    <Bar dataKey="bookings" fill={T.yellow} radius={[3, 3, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              )}
            </div>

            {/* Jobs by service */}
            <div style={{ background: T.white, border: `1px solid ${T.lightGray}`, borderRadius: "8px", padding: "16px" }}>
              <p style={sectionLabel}>Jobs by Service</p>
              {serviceData.length === 0 ? (
                <div style={{ fontSize: "12px", color: T.gray, fontStyle: "italic", paddingTop: "8px" }}>No data yet.</div>
              ) : (
                <ResponsiveContainer width="100%" height={160}>
                  <BarChart data={serviceData} layout="vertical" margin={{ top: 0, right: 8, bottom: 0, left: 8 }}>
                    <XAxis type="number" tick={{ fontSize: 10 }} allowDecimals={false} />
                    <YAxis type="category" dataKey="name" tick={{ fontSize: 10 }} width={110} />
                    <Tooltip formatter={(v) => [v, "Jobs"]} />
                    <Bar dataKey="count" radius={[0, 3, 3, 0]}>
                      {serviceData.map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              )}
            </div>
          </div>

          {/* Revenue table */}
          <div style={{ background: T.white, border: `1px solid ${T.lightGray}`, borderRadius: "8px", padding: "16px", marginBottom: "8px" }}>
            <p style={sectionLabel}>Revenue by Service</p>
            <table style={{ width: "100%", borderCollapse: "collapse", marginTop: "8px" }}>
              <thead>
                <tr>
                  {["Service", "Jobs", "Est. Revenue"].map(h => (
                    <th key={h} style={{ padding: "6px 10px", fontSize: "11px", fontWeight: 700, color: T.gray, textTransform: "uppercase", letterSpacing: "0.07em", borderBottom: `2px solid ${T.lightGray}`, textAlign: h === "Service" ? "left" : "right" }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {Object.values(svcStats).sort((a, b) => b.revenue - a.revenue).map((s, i) => (
                  <tr key={i}>
                    <td style={{ padding: "8px 10px", fontSize: "13px", borderBottom: `1px solid ${T.offWhite}` }}>{s.name}</td>
                    <td style={{ padding: "8px 10px", fontSize: "13px", textAlign: "right", borderBottom: `1px solid ${T.offWhite}` }}>{s.count}</td>
                    <td style={{ padding: "8px 10px", fontSize: "13px", fontWeight: 600, textAlign: "right", borderBottom: `1px solid ${T.offWhite}`, color: s.priced ? T.black : T.gray }}>
                      {s.priced ? fmt(s.revenue) : "Quote"}
                    </td>
                  </tr>
                ))}
                <tr>
                  <td style={{ padding: "10px 10px", fontWeight: 700, fontSize: "13px", borderTop: `2px solid ${T.lightGray}` }}>Total</td>
                  <td style={{ padding: "10px 10px", fontWeight: 700, fontSize: "13px", textAlign: "right", borderTop: `2px solid ${T.lightGray}` }}>{totalJobs}</td>
                  <td style={{ padding: "10px 10px", fontWeight: 700, fontSize: "15px", textAlign: "right", borderTop: `2px solid ${T.lightGray}`, color: T.yellow }}>{fmt(totalRevenue)}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

// ── Admin ─────────────────────────────────────────────────────────────────────
function AdminView({ bookings, onCancel, onUpdate, onBook, onClear, settings, onUpdateSettings, isMobile, lastRefresh }) {
  const [adminMode, setAdminMode]       = useState("schedule");
  const [filter, setFilter]             = useState("upcoming");
  const [clearConfirm, setClearConfirm] = useState(null);
  const [deleteConfirm, setDeleteConfirm] = useState(null);
  const [cancelConfirm, setCC]     = useState(null);
  const [overrideDate, setOvrDate]    = useState("");
  const [overrideEndDate, setOvrEnd]  = useState("");
  const [overrideBays, setOvrBays]    = useState(1);

  const today = todayStr();

  const todayCount     = bookings.filter(b => b.date === today && b.status === "confirmed").length;
  const upcomingCount  = bookings.filter(b => b.date >= today  && b.status === "confirmed").length;
  const pendingCount   = bookings.filter(b => b.status === "pending").length;
  const completedCount = bookings.filter(b => b.status === "completed").length;

  const filtered = [...bookings]
    .filter(b => {
      if (filter === "pending")   return b.status === "pending";
      if (filter === "today")     return b.date === today && b.status === "confirmed";
      if (filter === "upcoming")  return b.date >= today  && b.status === "confirmed";
      if (filter === "completed") return b.status === "completed";
      return b.status !== "pending";
    })
    .sort((a, b) => a.date.localeCompare(b.date) || a.hour - b.hour);

  const doCancel  = async (id) => { await onCancel(id); setCC(null); };
  const doApprove = async (id) => {
    const b = bookings.find(bk => bk.id === id);
    if (!b) return;
    // Check if bay is still free before approving
    const svcs = getServices(settings);
    const dur = getBkDuration(b, svcs);
    const occupied = getOccupiedBaysAt(bookings, b.date, b.hour, dur, settings);
    if (occupied.has(b.bay)) {
      // Try to find another free bay
      const eb = getEffectiveBays(settings, b.date);
      let freeBay = null;
      for (let bay = 1; bay <= eb; bay++) {
        if (!occupied.has(bay)) { freeBay = bay; break; }
      }
      if (!freeBay) {
        alert("No bays are available at that time anymore. Please reschedule before approving.");
        return;
      }
      await onUpdate(id, { status: "confirmed", bay: freeBay });
    } else {
      await onUpdate(id, { status: "confirmed" });
    }
    // Send confirmation email if configured
    await sendConfirmationEmail(b, settings);
  };
  const doDecline = async (id) => { await onUpdate(id, { status: "declined" }); };

  return (
    <div style={{ maxWidth: "940px", margin: "0 auto", padding: isMobile ? "20px 12px" : "32px 24px" }}>
      <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", flexWrap: "wrap", gap: "8px", marginBottom: "16px" }}>
        <div>
          <h1 style={{ margin: "0 0 4px", fontFamily: "'Space Grotesk', system-ui, sans-serif", fontWeight: 700, fontSize: isMobile ? "20px" : "24px" }}>Admin Dashboard</h1>
          <p style={{ margin: 0, color: T.gray, fontSize: "14px" }}>Manage appointments across all bays.</p>
        </div>
        {lastRefresh && (
          <div style={{ fontSize: "11px", color: T.gray, display: "flex", alignItems: "center", gap: "5px", paddingBottom: "2px" }}>
            <span style={{ width: "7px", height: "7px", borderRadius: "50%", background: "#22C55E", display: "inline-block", flexShrink: 0 }} />
            Live · updated {lastRefresh.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
          </div>
        )}
      </div>

      {/* Mode toggle */}
      <div style={{ display: "flex", gap: "3px", background: "#EBEBEB", borderRadius: "7px", padding: "3px", width: "fit-content", marginBottom: "24px" }}>
        {[["schedule", "Schedule"], ["settings", "⚙ Settings"]].map(([m, l]) => (
          <button key={m} onClick={() => setAdminMode(m)} style={{
            padding: "6px 18px", border: "none", borderRadius: "5px", cursor: "pointer",
            fontSize: "13px", fontWeight: adminMode === m ? 600 : 400, fontFamily: "inherit",
            background: adminMode === m ? T.white : "transparent",
            color: adminMode === m ? T.black : T.gray,
            boxShadow: adminMode === m ? "0 1px 3px rgba(0,0,0,0.1)" : "none",
          }}>{l}</button>
        ))}
      </div>

      {adminMode === "settings" && <SettingsPanel settings={settings} onUpdate={onUpdateSettings} />}
      {adminMode === "schedule" && <>

      {/* Stats */}
      <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr 1fr" : "repeat(5, 1fr)", gap: "8px", marginBottom: "20px" }}>
        {[
          { label: "Today's Appointments", value: todayCount,    note: `across ${settings.totalBays} bays`, accent: false,            filter: null },
          { label: "Upcoming",             value: upcomingCount, note: "confirmed bookings",                accent: false,            filter: "upcoming" },
          { label: "Completed",            value: completedCount, note: "jobs marked done",                accent: false,            filter: "completed" },
          { label: "Pending Approval",     value: pendingCount,  note: "awaiting your review",             accent: pendingCount > 0, filter: "pending" },
          { label: "Total Confirmed",      value: bookings.filter(b => b.status === "confirmed").length, note: "all time", accent: false, filter: null },
        ].map((stat, i) => (
          <div key={i} onClick={() => stat.filter && setFilter(stat.filter)}
            style={{ background: stat.accent ? "#FEF3C7" : T.white, border: `1px solid ${stat.accent ? "#FCD34D" : T.lightGray}`, borderRadius: "8px", padding: "16px", cursor: stat.filter ? "pointer" : "default" }}>
            <div style={{ fontFamily: "'Space Grotesk', system-ui, sans-serif", fontWeight: 700, fontSize: "26px", lineHeight: 1, marginBottom: "4px", color: stat.accent ? "#92400E" : T.black }}>{stat.value}</div>
            <div style={{ fontWeight: 600, fontSize: "12px", marginBottom: "2px", color: stat.accent ? "#92400E" : T.black }}>{stat.label}</div>
            <div style={{ fontSize: "11px", color: stat.accent ? "#B45309" : T.gray }}>{stat.note}</div>
          </div>
        ))}
      </div>

      {/* Calendar */}
      <CalendarPanel bookings={bookings} settings={settings} onBook={onBook} onCancel={onCancel} onUpdate={onUpdate} />

      {/* Bay Settings */}
      <div style={{ background: T.white, border: `1px solid ${T.lightGray}`, borderRadius: "8px", padding: "20px", marginBottom: "20px" }}>
        <p style={{ margin: "0 0 16px", fontSize: "11px", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.08em", color: T.gray }}>Bay Settings</p>

        {/* Global bay count */}
        <div style={{ display: "flex", alignItems: "center", gap: "16px", marginBottom: "20px", paddingBottom: "20px", borderBottom: `1px solid ${T.offWhite}` }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 600, fontSize: "14px", marginBottom: "2px" }}>Total Mechanics</div>
            <div style={{ fontSize: "12px", color: T.gray }}>Affects all days without a specific exception set below.</div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
            <button onClick={() => settings.totalBays > 1 && onUpdateSettings({ totalBays: settings.totalBays - 1 })}
              style={{ width: "32px", height: "32px", border: `1px solid ${T.lightGray}`, borderRadius: "6px", background: T.white, fontSize: "18px", cursor: settings.totalBays > 1 ? "pointer" : "not-allowed", color: settings.totalBays > 1 ? T.black : T.lightGray, fontFamily: "inherit", display: "flex", alignItems: "center", justifyContent: "center" }}>−</button>
            <span style={{ fontFamily: "'Space Grotesk', system-ui, sans-serif", fontWeight: 700, fontSize: "24px", minWidth: "24px", textAlign: "center" }}>{settings.totalBays}</span>
            <button onClick={() => settings.totalBays < 10 && onUpdateSettings({ totalBays: settings.totalBays + 1 })}
              style={{ width: "32px", height: "32px", border: `1px solid ${T.lightGray}`, borderRadius: "6px", background: T.white, fontSize: "18px", cursor: settings.totalBays < 10 ? "pointer" : "not-allowed", color: settings.totalBays < 10 ? T.black : T.lightGray, fontFamily: "inherit", display: "flex", alignItems: "center", justifyContent: "center" }}>+</button>
          </div>
        </div>

        {/* Day exceptions */}
        <div style={{ fontWeight: 600, fontSize: "13px", marginBottom: "10px" }}>Day Exceptions</div>
        <div style={{ fontSize: "12px", color: T.gray, marginBottom: "12px" }}>Reduce available bays for a day or a range of days — useful when a mechanic calls out for multiple days.</div>
        <div style={{ display: "flex", gap: "8px", marginBottom: "10px", flexWrap: "wrap", alignItems: "flex-end" }}>
          <div>
            <label style={{ ...labelStyle, marginBottom: "4px" }}>From</label>
            <input type="date" value={overrideDate} min={minDate()} max={getMaxDate(settings)}
              onChange={e => { const v = e.target.value; if (v && !isWeekendClosed(v, settings) && !isHolidayClosed(v)) setOvrDate(v); else if (!v) { setOvrDate(""); setOvrEnd(""); } }}
              style={{ ...inputStyle, width: "150px" }} />
          </div>
          <div>
            <label style={{ ...labelStyle, marginBottom: "4px" }}>To <span style={{ fontWeight: 400, textTransform: "none", letterSpacing: 0 }}>(optional)</span></label>
            <input type="date" value={overrideEndDate} min={overrideDate || minDate()} max={getMaxDate(settings)}
              onChange={e => { const v = e.target.value; if (v && !isSunday(v)) setOvrEnd(v); else if (!v) setOvrEnd(""); }}
              style={{ ...inputStyle, width: "150px" }} />
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
            <span style={{ fontSize: "13px", color: T.gray }}>Bays:</span>
            {Array.from({ length: settings.totalBays }, (_, i) => i + 1).map(n => (
              <button key={n} onClick={() => setOvrBays(n)} style={{
                width: "32px", height: "32px", border: `2px solid ${overrideBays === n ? T.yellow : T.lightGray}`,
                borderRadius: "6px", background: overrideBays === n ? T.yellowBg : T.white,
                fontWeight: overrideBays === n ? 700 : 400, fontSize: "14px", cursor: "pointer", fontFamily: "inherit",
                color: overrideBays === n ? T.yellow : T.black,
              }}>{n}</button>
            ))}
          </div>
          <button disabled={!overrideDate} onClick={() => {
            if (!overrideDate) return;
            const end = overrideEndDate || overrideDate;
            const next = { ...settings.dayOverrides };
            // Loop through every day in range, skip weekends and holidays
            let cur = new Date(overrideDate + "T12:00:00");
            const endDate = new Date(end + "T12:00:00");
            while (cur <= endDate) {
              const ds = toDateStr(cur);
              if (!isWeekendClosed(ds, settings) && !isHolidayClosed(ds)) next[ds] = overrideBays;
              cur.setDate(cur.getDate() + 1);
            }
            onUpdateSettings({ dayOverrides: next });
            setOvrDate(""); setOvrEnd(""); setOvrBays(1);
          }} style={overrideDate ? { ...btn.primary, padding: "8px 16px" } : { ...btn.disabled, padding: "8px 16px" }}>
            Add Exception{overrideEndDate && overrideEndDate !== overrideDate ? "s" : ""}
          </button>
        </div>

        {/* List of existing exceptions */}
        {Object.keys(settings.dayOverrides || {}).length === 0 ? (
          <div style={{ fontSize: "12px", color: T.gray, fontStyle: "italic" }}>No exceptions set.</div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
            {Object.entries(settings.dayOverrides)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([date, bays]) => (
                <div key={date} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", background: T.offWhite, borderRadius: "6px", padding: "8px 12px" }}>
                  <span style={{ fontSize: "13px" }}>
                    <strong>{displayDate(date).replace(/,.*$/, "")}, {date.slice(5).replace("-", "/")}</strong>
                    <span style={{ color: T.gray, marginLeft: "8px" }}>— {bays} bay{bays !== 1 ? "s" : ""} available</span>
                  </span>
                  <button onClick={() => {
                    const next = { ...settings.dayOverrides };
                    delete next[date];
                    onUpdateSettings({ dayOverrides: next });
                  }} style={{ border: "none", background: "none", cursor: "pointer", color: T.gray, fontSize: "16px", padding: "0 4px", lineHeight: 1 }}>×</button>
                </div>
              ))}
          </div>
        )}
      </div>

      {/* Filter tabs */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "14px", flexWrap: "wrap", gap: "8px" }}>
        <div style={{ display: "flex", gap: "3px", background: "#EBEBEB", borderRadius: "7px", padding: "3px", flexWrap: "wrap" }}>
          {[["upcoming", "Upcoming"], ["today", "Today"], ["completed", `Completed${completedCount > 0 ? ` (${completedCount})` : ""}`], ["pending", `Pending${pendingCount > 0 ? ` (${pendingCount})` : ""}`], ["all", "All"]].map(([val, label]) => (
            <button key={val} onClick={() => setFilter(val)} style={{
              padding: "5px 16px", border: "none", borderRadius: "5px", cursor: "pointer",
              fontSize: "13px", fontWeight: 500, fontFamily: "inherit",
              background: filter === val ? T.white : "transparent",
              color: filter === val ? T.black : T.gray,
              boxShadow: filter === val ? "0 1px 3px rgba(0,0,0,0.1)" : "none",
            }}>{label}</button>
          ))}
        </div>
        <div style={{ display: "flex", gap: "6px" }}>
          {[
            { key: "past",      label: "Clear Past",      count: bookings.filter(b => b.date < today && b.status === "confirmed").length },
            { key: "cancelled", label: "Clear Cancelled", count: bookings.filter(b => b.status === "cancelled" || b.status === "declined").length },
          ].map(({ key, label, count }) => (
            count > 0 && (
              <button key={key} onClick={() => setClearConfirm(key)}
                style={{ border: `1px solid ${T.lightGray}`, background: T.white, color: T.gray, borderRadius: "6px", padding: "5px 12px", fontSize: "12px", cursor: "pointer", fontFamily: "inherit" }}>
                {label} ({count})
              </button>
            )
          ))}
        </div>
      </div>

      {/* Clear confirmation */}
      {clearConfirm && (() => {
        const isPast = clearConfirm === "past";
        const count  = isPast
          ? bookings.filter(b => b.date < today && b.status === "confirmed").length
          : bookings.filter(b => b.status === "cancelled" || b.status === "declined").length;
        const label  = isPast ? "past completed appointments" : "cancelled & declined appointments";
        return (
          <div style={{ background: "#FEF3C7", border: "1px solid #FCD34D", borderRadius: "8px", padding: "12px 16px", marginBottom: "14px", display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: "10px" }}>
            <span style={{ fontSize: "13px", color: "#92400E" }}>
              Remove <strong>{count}</strong> {label}? This can't be undone.
            </span>
            <div style={{ display: "flex", gap: "6px" }}>
              <button onClick={() => {
                if (isPast) onClear(b => !(b.date < today && b.status === "confirmed"));
                else        onClear(b => b.status !== "cancelled" && b.status !== "declined");
                setClearConfirm(null);
              }} style={{ border: "none", background: T.red, color: "#fff", borderRadius: "5px", padding: "5px 14px", fontSize: "12px", fontWeight: 600, cursor: "pointer", fontFamily: "inherit" }}>
                Yes, remove
              </button>
              <button onClick={() => setClearConfirm(null)}
                style={{ border: `1px solid #FCD34D`, background: T.white, color: "#92400E", borderRadius: "5px", padding: "5px 14px", fontSize: "12px", cursor: "pointer", fontFamily: "inherit" }}>
                Cancel
              </button>
            </div>
          </div>
        );
      })()}

      {/* List */}
      {filtered.length === 0 ? (
        <div style={{ textAlign: "center", padding: "48px", color: T.gray, fontSize: "14px", background: T.white, border: `1px solid ${T.lightGray}`, borderRadius: "8px" }}>
          No bookings to display.
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
          {filtered.map(b => {
            const bSvcs = getServices(settings).filter(sv => (b.serviceIds || [b.serviceId]).includes(sv.id));
            const bSlot = getTimeSlots(settings).find(t => t.value === b.hour);
            const confirming = cancelConfirm === b.id;
            const cancelled  = b.status === "cancelled";
            const pending    = b.status === "pending";
            const declined   = b.status === "declined";
            const completed  = b.status === "completed";
            const isBlock    = !!b.isBlock;

            const ARRIVAL_OPTS = [
              { val: null,       label: "Not Arrived",    color: T.gray,    bg: T.offWhite, border: T.lightGray },
              { val: "waiting",  label: "Waiting on Car", color: "#92400E", bg: "#FEF3C7",  border: "#FCD34D"   },
              { val: "drop-off", label: "Dropped Off",    color: "#1D4ED8", bg: "#DBEAFE",  border: "#93C5FD"   },
            ];
            const arrivalOpt = ARRIVAL_OPTS.find(o => o.val === (b.arrival ?? null));

            return (
              <div key={b.id} style={{ background: T.white, border: `1px solid ${completed ? "#86EFAC" : pending ? "#FCD34D" : T.lightGray}`, borderRadius: "8px", overflow: "hidden", opacity: (cancelled || declined) ? 0.5 : 1 }}>

                {/* Status banner */}
                {isBlock && (
                  <div style={{ background: "#F5F3FF", borderBottom: "1px solid #C4B5FD", padding: "5px 16px" }}>
                    <span style={{ fontSize: "11px", fontWeight: 700, color: "#6D28D9", textTransform: "uppercase", letterSpacing: "0.06em" }}>🔧 Custom Job — {b.name}</span>
                  </div>
                )}
                {completed && !isBlock && (
                  <div style={{ background: "#F0FDF4", borderBottom: "1px solid #86EFAC", padding: "6px 16px", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                    <span style={{ fontSize: "11px", fontWeight: 700, color: "#166534", textTransform: "uppercase", letterSpacing: "0.06em" }}>✓ Job Complete</span>
                    <button onClick={() => onUpdate(b.id, { status: "confirmed" })} style={{ border: "1px solid #86EFAC", background: T.white, color: "#166534", borderRadius: "4px", padding: "2px 10px", fontSize: "11px", cursor: "pointer", fontFamily: "inherit" }}>Undo</button>
                  </div>
                )}
                {pending && (
                  <div style={{ background: "#FEF3C7", borderBottom: "1px solid #FCD34D", padding: "6px 16px", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                    <span style={{ fontSize: "11px", fontWeight: 700, color: "#92400E", textTransform: "uppercase", letterSpacing: "0.06em" }}>⏳ Awaiting Approval</span>
                    <div style={{ display: "flex", gap: "6px" }}>
                      <button onClick={() => doApprove(b.id)} style={{ border: "none", background: T.yellow, color: T.white, borderRadius: "4px", padding: "4px 12px", fontSize: "12px", fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>Approve</button>
                      <button onClick={() => doDecline(b.id)} style={{ border: "1px solid #FCD34D", background: T.white, color: "#92400E", borderRadius: "4px", padding: "4px 12px", fontSize: "12px", cursor: "pointer", fontFamily: "inherit" }}>Decline</button>
                    </div>
                  </div>
                )}
                {declined && (
                  <div style={{ background: "#FEE2E2", borderBottom: "1px solid #FCA5A5", padding: "5px 16px" }}>
                    <span style={{ fontSize: "11px", fontWeight: 700, color: T.red, textTransform: "uppercase", letterSpacing: "0.06em" }}>✕ Declined</span>
                  </div>
                )}

                {/* Arrival status banner */}
                {!cancelled && b.arrival && (
                  <div style={{ background: arrivalOpt?.bg, borderBottom: `1px solid ${arrivalOpt?.border}`, padding: "5px 16px" }}>
                    <span style={{ fontSize: "11px", fontWeight: 700, color: arrivalOpt?.color, textTransform: "uppercase", letterSpacing: "0.06em" }}>
                      {b.arrival === "waiting" ? "⏱ Waiting on Car" : "✓ Dropped Off"}
                    </span>
                  </div>
                )}

                {/* Main card body */}
                <div style={{ padding: "12px 14px", display: "flex", gap: "10px", alignItems: "flex-start", flexWrap: isMobile ? "wrap" : "nowrap" }}>

                  {/* Bay badge */}
                  <div style={{ width: "42px", height: "42px", background: (cancelled || declined) ? "#E0E0E0" : isBlock ? "#7C3AED" : completed ? "#22C55E" : pending ? "#F59E0B" : T.yellow, borderRadius: "6px", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                    <span style={{ fontSize: "8px", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.04em", color: "rgba(255,255,255,0.7)", lineHeight: 1 }}>BAY</span>
                    <span style={{ fontSize: "16px", fontWeight: 700, fontFamily: "monospace", lineHeight: 1.2, color: T.white }}>{b.bay}</span>
                  </div>

                  {/* Info: two columns or stacked */}
                  <div style={{ flex: 1, minWidth: 0, display: "flex", gap: "10px", justifyContent: "space-between", flexWrap: "wrap" }}>
                    {/* Left: name, vehicle, services */}
                    <div style={{ minWidth: "160px" }}>
                      <div style={{ fontWeight: 700, fontSize: "15px", marginBottom: "2px" }}>{b.name}</div>
                      <div style={{ fontSize: "13px", color: T.black, marginBottom: "2px" }}>{b.year} {b.make} {b.model}</div>
                      <div style={{ fontSize: "12px", color: T.gray }}>{bSvcs.map(s => s.name).join(" · ")}</div>
                      {b.notes && (
                        <div style={{ fontSize: "12px", color: T.gray, marginTop: "5px", fontStyle: "italic", background: T.offWhite, borderRadius: "4px", padding: "4px 8px", borderLeft: `3px solid ${T.lightGray}` }}>
                          "{b.notes}"
                        </div>
                      )}
                    </div>
                    {/* Right: date, time, contact */}
                    <div style={{ textAlign: "right", minWidth: "160px" }}>
                      <div style={{ fontWeight: 600, fontSize: "13px", marginBottom: "2px" }}>
                        {b.date ? displayDate(b.date).replace(/,.*$/, "") : ""}, {b.date?.slice(5).replace("-", "/")}
                      </div>
                      <div style={{ fontSize: "12px", color: T.gray, marginBottom: "4px" }}>{bSlot?.label} · {bSvcs.reduce((s, sv) => s + sv.duration, 0)}h</div>
                      <div style={{ fontSize: "12px", color: T.gray }}>{b.phone}</div>
                      <div style={{ fontSize: "12px", color: T.gray }}>{b.email}</div>
                    </div>
                  </div>

                  {/* Cancel / Delete / ID */}
                  <div style={{ flexShrink: 0, display: "flex", flexDirection: isMobile ? "row" : "column", alignItems: isMobile ? "center" : "flex-end", gap: "4px", minWidth: isMobile ? "100%" : "90px", justifyContent: isMobile ? "flex-end" : "flex-start" }}>
                    <span style={{ fontFamily: "monospace", fontSize: "10px", color: "#ccc" }}>{b.id}</span>

                    {/* Active booking: cancel + delete */}
                    {!cancelled && !pending && !declined && !completed && !confirming && deleteConfirm !== b.id && (
                      <div style={{ display: "flex", gap: "4px" }}>
                        <button onClick={() => setCC(b.id)} style={{ border: `1px solid ${T.lightGray}`, background: T.white, color: T.gray, borderRadius: "4px", padding: "3px 10px", fontSize: "11px", cursor: "pointer", fontFamily: "inherit" }}>Cancel</button>
                        <button onClick={() => setDeleteConfirm(b.id)} style={{ border: "1px solid #FCA5A5", background: T.white, color: T.red, borderRadius: "4px", padding: "3px 10px", fontSize: "11px", cursor: "pointer", fontFamily: "inherit" }}>Delete</button>
                      </div>
                    )}
                    {!cancelled && !pending && !declined && !completed && confirming && (
                      <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
                        <button onClick={() => doCancel(b.id)} style={{ border: "none", background: T.red, color: "#fff", borderRadius: "4px", padding: "4px 10px", fontSize: "11px", cursor: "pointer", fontFamily: "inherit", fontWeight: 600 }}>Confirm cancel</button>
                        <button onClick={() => setCC(null)} style={{ border: `1px solid ${T.lightGray}`, background: T.white, color: T.gray, borderRadius: "4px", padding: "4px 10px", fontSize: "11px", cursor: "pointer", fontFamily: "inherit" }}>Keep</button>
                      </div>
                    )}
                    {!cancelled && !pending && !declined && !completed && deleteConfirm === b.id && (
                      <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
                        <button onClick={() => { onClear(bk => bk.id !== b.id); setDeleteConfirm(null); }} style={{ border: "none", background: T.red, color: "#fff", borderRadius: "4px", padding: "4px 10px", fontSize: "11px", cursor: "pointer", fontFamily: "inherit", fontWeight: 600 }}>Confirm delete</button>
                        <button onClick={() => setDeleteConfirm(null)} style={{ border: `1px solid ${T.lightGray}`, background: T.white, color: T.gray, borderRadius: "4px", padding: "4px 10px", fontSize: "11px", cursor: "pointer", fontFamily: "inherit" }}>Keep</button>
                      </div>
                    )}

                    {/* Cancelled/declined: status badge + delete */}
                    {(cancelled || declined) && deleteConfirm !== b.id && (
                      <div style={{ display: "flex", gap: "4px", alignItems: "center" }}>
                        <span style={{ fontSize: "11px", color: "#bbb", background: T.offWhite, padding: "2px 8px", borderRadius: "4px" }}>{cancelled ? "Cancelled" : "Declined"}</span>
                        <button onClick={() => setDeleteConfirm(b.id)} style={{ border: "1px solid #FCA5A5", background: T.white, color: T.red, borderRadius: "4px", padding: "3px 8px", fontSize: "11px", cursor: "pointer", fontFamily: "inherit" }}>Delete</button>
                      </div>
                    )}
                    {(cancelled || declined) && deleteConfirm === b.id && (
                      <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
                        <button onClick={() => { onClear(bk => bk.id !== b.id); setDeleteConfirm(null); }} style={{ border: "none", background: T.red, color: "#fff", borderRadius: "4px", padding: "4px 10px", fontSize: "11px", cursor: "pointer", fontFamily: "inherit", fontWeight: 600 }}>Confirm delete</button>
                        <button onClick={() => setDeleteConfirm(null)} style={{ border: `1px solid ${T.lightGray}`, background: T.white, color: T.gray, borderRadius: "4px", padding: "4px 10px", fontSize: "11px", cursor: "pointer", fontFamily: "inherit" }}>Keep</button>
                      </div>
                    )}

                    {/* Completed: just delete */}
                    {completed && deleteConfirm !== b.id && (
                      <button onClick={() => setDeleteConfirm(b.id)} style={{ border: "1px solid #FCA5A5", background: T.white, color: T.red, borderRadius: "4px", padding: "3px 8px", fontSize: "11px", cursor: "pointer", fontFamily: "inherit" }}>Delete</button>
                    )}
                    {completed && deleteConfirm === b.id && (
                      <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
                        <button onClick={() => { onClear(bk => bk.id !== b.id); setDeleteConfirm(null); }} style={{ border: "none", background: T.red, color: "#fff", borderRadius: "4px", padding: "4px 10px", fontSize: "11px", cursor: "pointer", fontFamily: "inherit", fontWeight: 600 }}>Confirm delete</button>
                        <button onClick={() => setDeleteConfirm(null)} style={{ border: `1px solid ${T.lightGray}`, background: T.white, color: T.gray, borderRadius: "4px", padding: "4px 10px", fontSize: "11px", cursor: "pointer", fontFamily: "inherit" }}>Keep</button>
                      </div>
                    )}
                  </div>
                </div>

                {/* Arrival controls — hide when completed or block */}
                {!cancelled && !pending && !declined && !completed && !isBlock && (
                  <div style={{ borderTop: `1px solid ${T.offWhite}`, padding: "10px 16px", display: "flex", alignItems: "center", gap: "6px", flexWrap: "wrap" }}>
                    <span style={{ fontSize: "11px", color: T.gray, marginRight: "4px", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em" }}>Arrival:</span>
                    {ARRIVAL_OPTS.map(opt => {
                      const active = (b.arrival ?? null) === opt.val;
                      return (
                        <button key={String(opt.val)} onClick={() => onUpdate(b.id, { arrival: opt.val })} style={{
                          padding: "4px 12px", fontSize: "12px", fontFamily: "inherit", fontWeight: active ? 600 : 400,
                          border: `1px solid ${active ? opt.border : T.lightGray}`,
                          borderRadius: "5px", cursor: "pointer",
                          background: active ? opt.bg : T.white,
                          color: active ? opt.color : T.gray,
                        }}>{opt.label}</button>
                      );
                    })}
                  </div>
                )}

                {/* Mark Complete — shown for all confirmed bookings */}
                {!cancelled && !pending && !declined && !completed && !isBlock && (
                  <div style={{ borderTop: `1px solid ${T.offWhite}`, padding: "8px 16px", display: "flex", justifyContent: "flex-end" }}>
                    <button onClick={() => onUpdate(b.id, { status: "completed" })}
                      style={{ border: "none", background: "#22C55E", color: T.white, borderRadius: "5px", padding: "5px 16px", fontSize: "12px", fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>
                      ✓ Mark as Complete
                    </button>
                  </div>
                )}

                {/* Admin notes */}
                {!cancelled && !pending && !declined && !completed && !isBlock && (
                  <div style={{ borderTop: `1px solid ${T.offWhite}`, padding: "10px 16px" }}>
                    <textarea
                      placeholder="Admin notes — special instructions, parts needed, customer requests…"
                      value={b.adminNotes || ""}
                      onChange={e => onUpdate(b.id, { adminNotes: e.target.value })}
                      style={{
                        width: "100%", boxSizing: "border-box", resize: "vertical",
                        minHeight: "48px", maxHeight: "120px",
                        border: `1px solid ${T.lightGray}`, borderRadius: "6px",
                        padding: "8px 10px", fontSize: "12px", fontFamily: "inherit",
                        color: T.black, background: T.offWhite, outline: "none",
                        lineHeight: "1.5",
                      }}
                    />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      <RevenueReport bookings={bookings} settings={settings} />
      </>}
    </div>
  );
} 

// ── Admin Booking Modal ───────────────────────────────────────────────────────
function AdminBookModal({ prefillDate, prefillHour, prefillBay, bookings, settings, onBook, onClose }) {
  const [form, setForm]     = useState({ name: "", phone: "", email: "", make: "", model: "", year: "", notes: "" });
  const [serviceIds, setSvc] = useState([]);
  const [date, setDate]     = useState(() => prefillDate && !isWeekendClosed(prefillDate, settings) && !isDateClosed(prefillDate, settings) ? prefillDate : "");
  const [hour, setHour]     = useState(prefillHour ?? null);
  const [bay, setBay]       = useState(prefillBay ?? null);
  const [saving, setSaving] = useState(false);

  const activeServices = getServices(settings);
  const selectedSvcs  = activeServices.filter(s => serviceIds.includes(s.id));
  const totalDuration = selectedSvcs.reduce((sum, s) => sum + s.duration, 0);
  const halfDay       = date ? isHalfDay(date) : false;
  const effectiveBays = date ? getEffectiveBays(settings, date) : settings.totalBays;
  const dayClose      = date ? getDayHours(settings, date).close : getCloseHour(settings);
  const slots         = date && totalDuration > 0 ? getSlots(bookings, date, totalDuration, halfDay ? 12 : dayClose, effectiveBays, settings) : [];
  const formOk        = Object.values(form).every(v => v.trim()) && serviceIds.length > 0 && date && hour !== null;

  const handleSubmit = async () => {
    setSaving(true);
    const selectedSlot = slots.find(s => s.value === hour);
    const assignedBay  = bay ?? selectedSlot?.freeBay ?? 1;
    const booking = { id: genId(), ...form, serviceIds, date, hour, bay: assignedBay, status: "confirmed", createdAt: new Date().toISOString(), addedByAdmin: true };
    await onBook(booking);
    onClose();
  };

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center", padding: "20px" }}>
      <div style={{ background: T.white, borderRadius: "12px", width: "100%", maxWidth: "560px", maxHeight: "90vh", overflowY: "auto", boxShadow: "0 20px 60px rgba(0,0,0,0.3)" }}>
        {/* Modal header */}
        <div style={{ padding: "20px 24px 16px", borderBottom: `1px solid ${T.lightGray}`, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <h2 style={{ margin: 0, fontFamily: "'Space Grotesk', system-ui, sans-serif", fontWeight: 700, fontSize: "18px" }}>New Appointment</h2>
          <button onClick={onClose} style={{ border: "none", background: "none", fontSize: "20px", cursor: "pointer", color: T.gray, padding: "0 4px", lineHeight: 1 }}>×</button>
        </div>

        <div style={{ padding: "20px 24px" }}>
          {/* Services */}
          <p style={sectionLabel}>Services</p>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "6px", marginBottom: "18px" }}>
            {activeServices.map(sv => {
              const on = serviceIds.includes(sv.id);
              return (
                <button key={sv.id} onClick={() => setSvc(p => on ? p.filter(id => id !== sv.id) : [...p, sv.id])}
                  style={{ padding: "8px 12px", border: `2px solid ${on ? T.yellow : T.lightGray}`, borderRadius: "6px", background: on ? T.yellowBg : T.white, textAlign: "left", cursor: "pointer", fontFamily: "inherit", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <span style={{ fontSize: "13px", fontWeight: on ? 600 : 400 }}>{sv.name}</span>
                  {on && <span style={{ color: T.yellow, fontSize: "12px" }}>✓</span>}
                </button>
              );
            })}
          </div>

          {/* Date & Time */}
          <p style={sectionLabel}>Date & Time</p>
          <div style={{ display: "flex", gap: "12px", marginBottom: "16px", flexWrap: "wrap" }}>
            <div style={{ flex: "0 0 auto" }}>
              <label style={labelStyle}>Date</label>
              <input type="date" min={minDate()} max={getMaxDate(settings)} value={date}
                onChange={e => { const v = e.target.value; if (v && !isWeekendClosed(v, settings) && !isDateClosed(v, settings)) { setDate(v); setHour(null); setBay(null); } else if (!v) setDate(""); }}
                style={{ ...inputStyle, width: "170px" }} />
            </div>
            {date && totalDuration > 0 && (
              <div style={{ flex: 1, minWidth: "200px" }}>
                <label style={labelStyle}>Time Slot</label>
                <div style={{ display: "flex", gap: "6px", flexWrap: "wrap" }}>
                  {slots.map(sl => (
                    <button key={sl.value} disabled={!sl.available}
                      onClick={() => { setHour(sl.value); setBay(sl.freeBay); }}
                      style={{ padding: "8px 12px", fontSize: "13px", fontFamily: "inherit", fontWeight: hour === sl.value ? 700 : 400, border: `2px solid ${hour === sl.value ? T.yellow : sl.available ? T.lightGray : "#F0F0F0"}`, borderRadius: "6px", background: hour === sl.value ? T.yellowBg : sl.available ? T.white : "#F8F8F8", color: sl.available ? T.black : "#ccc", cursor: sl.available ? "pointer" : "not-allowed" }}>
                      {sl.label}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* Customer info */}
          <p style={sectionLabel}>Customer</p>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px", marginBottom: "12px" }}>
            {[["name","Full Name","Jane Smith"],["phone","Phone","(555) 000-0000"]].map(([k,l,ph]) => (
              <div key={k}><label style={labelStyle}>{l}</label><input style={inputStyle} placeholder={ph} value={form[k]} onChange={e => setForm(p => ({ ...p, [k]: e.target.value }))} /></div>
            ))}
            <div style={{ gridColumn: "1/-1" }}>
              <label style={labelStyle}>Email</label>
              <input type="email" style={inputStyle} placeholder="jane@email.com" value={form.email} onChange={e => setForm(p => ({ ...p, email: e.target.value }))} />
            </div>
          </div>

          {/* Vehicle */}
          <p style={sectionLabel}>Vehicle</p>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(80px, 1fr))", gap: "12px", marginBottom: "16px" }}>
            {[["make","Make","Toyota"],["model","Model","Camry"],["year","Year","2019"]].map(([k,l,ph]) => (
              <div key={k}><label style={labelStyle}>{l}</label><input style={inputStyle} placeholder={ph} maxLength={k==="year"?4:undefined} value={form[k]} onChange={e => setForm(p => ({ ...p, [k]: e.target.value }))} /></div>
            ))}
          </div>

          {/* Notes */}
          <div style={{ marginBottom: "24px" }}>
            <label style={labelStyle}>Notes <span style={{ fontWeight: 400, textTransform: "none", letterSpacing: 0, color: T.gray }}>(optional)</span></label>
            <textarea placeholder="Special instructions, parts needed, customer requests..." value={form.notes}
              onChange={e => setForm(p => ({ ...p, notes: e.target.value }))}
              style={{ ...inputStyle, display: "block", resize: "vertical", minHeight: "70px", lineHeight: "1.5" }} />
          </div>

          <div style={{ display: "flex", justifyContent: "flex-end", gap: "8px" }}>
            <button onClick={onClose} style={btn.ghost}>Cancel</button>
            <button onClick={handleSubmit} disabled={!formOk || saving} style={!formOk || saving ? btn.disabled : btn.primary}>
              {saving ? "Saving…" : "Confirm Appointment"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Bay Block Modal ───────────────────────────────────────────────────────────
function BayBlockModal({ bookings, settings, onBook, onClose }) {
  const [bay,       setBay]       = useState(1);
  const [date,      setDate]      = useState("");
  const [endDate,   setEndDate]   = useState("");
  const [blockType, setBlockType] = useState("allday"); // "allday"|"hours"|"days"
  const [startHour, setStartHour] = useState(null);
  const [customHrs, setCustomHrs] = useState(2);
  const [note,      setNote]      = useState("");
  const [saving,    setSaving]    = useState(false);

  const slots = getTimeSlots(settings);
  const isValid = date && (blockType !== "hours" || startHour !== null) && (blockType !== "days" || endDate);

  const doBlock = async () => {
    setSaving(true);
    const label = note || "Custom Job";

    const createBlock = async (ds, hour, duration) => {
      await onBook({ id: genId(), name: label, phone: "", email: "", make: "", model: "", year: "",
        notes: note, serviceIds: [], customDuration: duration,
        date: ds, hour, bay, status: "confirmed", isBlock: true, createdAt: new Date().toISOString() });
    };

    if (blockType === "days" && endDate) {
      let cur = new Date(date + "T12:00:00");
      const end = new Date(endDate + "T12:00:00");
      while (cur <= end) {
        const ds = toDateStr(cur);
        if (!isWeekendClosed(ds, settings) && !isDateClosed(ds, settings)) {
          const dh = getDayHours(settings, ds);
          await createBlock(ds, dh.open, dh.close - dh.open);
        }
        cur.setDate(cur.getDate() + 1);
      }
    } else if (blockType === "allday") {
      const dh = getDayHours(settings, date);
      await createBlock(date, dh.open, dh.close - dh.open);
    } else {
      await createBlock(date, startHour, customHrs);
    }
    setSaving(false);
    onClose();
  };

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center", padding: "20px" }}>
      <div style={{ background: T.white, borderRadius: "12px", width: "100%", maxWidth: "480px", maxHeight: "90vh", overflowY: "auto", boxShadow: "0 20px 60px rgba(0,0,0,0.3)" }}>
        <div style={{ padding: "20px 24px 16px", borderBottom: `1px solid ${T.lightGray}`, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div>
            <h2 style={{ margin: "0 0 2px", fontFamily: "'Space Grotesk', system-ui, sans-serif", fontWeight: 700, fontSize: "18px" }}>Custom Job</h2>
            <p style={{ margin: 0, fontSize: "12px", color: T.gray }}>Reserve a bay for a long job — won't show as a customer appointment.</p>
          </div>
          <button onClick={onClose} style={{ border: "none", background: "none", fontSize: "20px", cursor: "pointer", color: T.gray, padding: "0 4px" }}>×</button>
        </div>

        <div style={{ padding: "20px 24px" }}>
          {/* Bay */}
          <p style={sectionLabel}>Bay</p>
          <div style={{ display: "flex", gap: "8px", marginBottom: "18px" }}>
            {Array.from({ length: settings.totalBays }, (_, i) => i + 1).map(n => (
              <button key={n} onClick={() => setBay(n)} style={{
                width: "44px", height: "44px", border: `2px solid ${bay === n ? "#7C3AED" : T.lightGray}`,
                borderRadius: "8px", background: bay === n ? "#7C3AED" : T.white,
                color: bay === n ? T.white : T.black, fontWeight: 700, fontSize: "15px",
                cursor: "pointer", fontFamily: "inherit",
              }}>B{n}</button>
            ))}
          </div>

          {/* Block type */}
          <p style={sectionLabel}>Duration Type</p>
          <div style={{ display: "flex", gap: "8px", marginBottom: "18px", flexWrap: "wrap" }}>
            {[["allday","All Day"],["hours","Custom Hours"],["days","Multiple Days"]].map(([val, lbl]) => (
              <button key={val} onClick={() => setBlockType(val)} style={{
                padding: "8px 14px", border: `2px solid ${blockType === val ? "#7C3AED" : T.lightGray}`,
                borderRadius: "6px", background: blockType === val ? "#F5F3FF" : T.white,
                fontWeight: blockType === val ? 700 : 400, cursor: "pointer", fontFamily: "inherit",
                fontSize: "13px", color: blockType === val ? "#7C3AED" : T.black,
              }}>{lbl}</button>
            ))}
          </div>

          {/* Date(s) */}
          <div style={{ display: "flex", gap: "12px", marginBottom: "18px", flexWrap: "wrap" }}>
            <div style={{ flex: 1, minWidth: "140px" }}>
              <label style={labelStyle}>{blockType === "days" ? "Start Date" : "Date"}</label>
              <input type="date" value={date} min={minDate()} max={getMaxDate(settings)}
                onChange={e => { const v = e.target.value; if (v && !isWeekendClosed(v, settings) && !isDateClosed(v, settings)) setDate(v); else if (!v) setDate(""); }}
                style={inputStyle} />
            </div>
            {blockType === "days" && (
              <div style={{ flex: 1, minWidth: "140px" }}>
                <label style={labelStyle}>End Date</label>
                <input type="date" value={endDate} min={date || minDate()} max={getMaxDate(settings)}
                  onChange={e => setEndDate(e.target.value)} style={inputStyle} />
              </div>
            )}
          </div>

          {/* Custom hours options */}
          {blockType === "hours" && (
            <>
              <p style={sectionLabel}>Start Time</p>
              <div style={{ display: "flex", gap: "6px", flexWrap: "wrap", marginBottom: "16px" }}>
                {slots.map(sl => (
                  <button key={sl.value} onClick={() => setStartHour(sl.value)} style={{
                    padding: "7px 12px", fontSize: "12px", fontFamily: "inherit",
                    border: `2px solid ${startHour === sl.value ? "#7C3AED" : T.lightGray}`,
                    borderRadius: "6px", background: startHour === sl.value ? "#F5F3FF" : T.white,
                    fontWeight: startHour === sl.value ? 700 : 400, cursor: "pointer",
                    color: startHour === sl.value ? "#7C3AED" : T.black,
                  }}>{sl.label}</button>
                ))}
              </div>
              <p style={sectionLabel}>Hours to Block</p>
              <div style={{ display: "flex", gap: "6px", flexWrap: "wrap", marginBottom: "18px" }}>
                {[1,2,3,4,5,6,7,8].map(n => (
                  <button key={n} onClick={() => setCustomHrs(n)} style={{
                    width: "38px", height: "38px", border: `2px solid ${customHrs === n ? "#7C3AED" : T.lightGray}`,
                    borderRadius: "6px", background: customHrs === n ? "#F5F3FF" : T.white,
                    fontWeight: customHrs === n ? 700 : 400, cursor: "pointer",
                    fontSize: "13px", fontFamily: "inherit", color: customHrs === n ? "#7C3AED" : T.black,
                  }}>{n}</button>
                ))}
              </div>
            </>
          )}

          {/* Note */}
          <div style={{ marginBottom: "24px" }}>
            <label style={labelStyle}>Job / Reason <span style={{ fontWeight: 400, textTransform: "none", letterSpacing: 0, color: T.gray }}>(optional)</span></label>
            <input value={note} onChange={e => setNote(e.target.value)}
              placeholder="e.g. Engine rebuild, waiting for parts..."
              style={inputStyle} />
          </div>

          <div style={{ display: "flex", justifyContent: "flex-end", gap: "8px" }}>
            <button onClick={onClose} style={btn.ghost}>Cancel</button>
            <button onClick={doBlock} disabled={!isValid || saving}
              style={{ ...(!isValid || saving ? btn.disabled : btn.primary), background: !isValid || saving ? undefined : "#7C3AED" }}>
              {saving ? "Saving…" : "Add Custom Job"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Calendar Panel ────────────────────────────────────────────────────────────
function CalendarPanel({ bookings, settings, onBook, onCancel, onUpdate }) {
  const [calView, setCalView]       = useState("week");
  const [calDate, setCalDate]       = useState(new Date());
  const [modal, setModal]           = useState(null);
  const [blockModal, setBlockModal] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);

  function navigate(dir) {
    const d = new Date(calDate);
    if (calView === "day")   d.setDate(d.getDate() + dir);
    if (calView === "week")  d.setDate(d.getDate() + dir * 7);
    if (calView === "month") d.setMonth(d.getMonth() + dir);
    setCalDate(d);
  }

  function title() {
    if (calView === "day") return calDate.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" });
    if (calView === "week") {
      const ws = getWeekStart(calDate), we = addDays(ws, 4);
      return `${ws.toLocaleDateString("en-US", { month: "short", day: "numeric" })} – ${we.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}`;
    }
    return calDate.toLocaleDateString("en-US", { month: "long", year: "numeric" });
  }

  const tabBtn = (v) => ({
    padding: "4px 14px", border: "none", borderRadius: "4px", cursor: "pointer",
    fontSize: "12px", fontWeight: calView === v ? 600 : 400, fontFamily: "inherit",
    background: calView === v ? T.white : "transparent",
    color: calView === v ? T.black : T.gray,
    boxShadow: calView === v ? "0 1px 2px rgba(0,0,0,0.1)" : "none",
  });

  return (
    <>
      {modal && (
        <AdminBookModal
          prefillDate={modal.date} prefillHour={modal.hour} prefillBay={modal.bay}
          bookings={bookings} settings={settings} onBook={onBook} onClose={() => setModal(null)}
        />
      )}
      {blockModal && (
        <BayBlockModal bookings={bookings} settings={settings} onBook={onBook} onClose={() => setBlockModal(false)} />
      )}
      <div style={fullscreen ? {
        position: "fixed", inset: 0, zIndex: 500, background: T.white,
        display: "flex", flexDirection: "column", overflow: "hidden",
      } : {
        background: T.white, border: `1px solid ${T.lightGray}`, borderRadius: "8px", overflow: "hidden", marginBottom: "20px",
      }}>
        {/* Header */}
        <div style={{ padding: "12px 14px", borderBottom: `1px solid ${T.offWhite}`, display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: "8px", flexShrink: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
            <button onClick={() => navigate(-1)} style={{ width: "28px", height: "28px", border: `1px solid ${T.lightGray}`, borderRadius: "5px", background: T.white, cursor: "pointer", fontSize: "16px", display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "inherit" }}>‹</button>
            <span style={{ fontWeight: 600, fontSize: "14px", minWidth: "200px", textAlign: "center" }}>{title()}</span>
            <button onClick={() => navigate(1)}  style={{ width: "28px", height: "28px", border: `1px solid ${T.lightGray}`, borderRadius: "5px", background: T.white, cursor: "pointer", fontSize: "16px", display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "inherit" }}>›</button>
            <button onClick={() => setCalDate(new Date())} style={{ border: `1px solid ${T.lightGray}`, background: T.white, borderRadius: "5px", padding: "4px 10px", fontSize: "12px", cursor: "pointer", color: T.gray, fontFamily: "inherit", marginLeft: "4px" }}>Today</button>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: "6px", flexWrap: "wrap" }}>
            <button onClick={() => setModal({})} style={{ ...btn.primary, padding: "6px 14px", fontSize: "13px" }}>+ New Appointment</button>
            <button onClick={() => setBlockModal(true)} style={{ ...btn.primary, padding: "6px 14px", fontSize: "13px" }}>+ Custom Job</button>
            <div style={{ display: "flex", gap: "2px", background: "#EBEBEB", borderRadius: "6px", padding: "3px" }}>
              {["day", "week", "month"].map(v => <button key={v} onClick={() => setCalView(v)} style={tabBtn(v)}>{v.charAt(0).toUpperCase() + v.slice(1)}</button>)}
            </div>
            <button onClick={() => setFullscreen(f => !f)} title={fullscreen ? "Exit fullscreen" : "Fullscreen"}
              style={{ width: "30px", height: "30px", border: `1px solid ${T.lightGray}`, borderRadius: "5px", background: fullscreen ? T.yellow : T.white, color: fullscreen ? T.white : T.gray, cursor: "pointer", fontSize: "14px", display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "inherit" }}>
              {fullscreen ? "✕" : "⛶"}
            </button>
          </div>
        </div>
        <div style={fullscreen ? { flex: 1, overflowY: "auto" } : {}}>
          {calView === "day"   && <CalDayView   date={calDate} bookings={bookings} settings={settings} onAdd={(date, hour, bay) => setModal({ date, hour, bay })} onCancel={onCancel} onUpdate={onUpdate} />}
          {calView === "week"  && <CalWeekView  date={calDate} bookings={bookings} settings={settings} setDate={setCalDate} setView={setCalView} onAdd={(date, hour) => setModal({ date, hour })} />}
          {calView === "month" && <CalMonthView date={calDate} bookings={bookings} settings={settings} setDate={setCalDate} setView={setCalView} />}
        </div>
      </div>
    </>
  );
}

function CalDayView({ date, bookings, settings, onAdd, onCancel, onUpdate }) {
  const ds = toDateStr(date);
  const effectiveBays = getEffectiveBays(settings, ds);
  const dayBks = bookings.filter(b => b.date === ds && (b.status === "confirmed" || b.status === "completed"));
  const isClosed  = isHolidayClosed(ds) || isWeekendClosed(ds, settings) || isDateClosed(ds, settings);
  const [cancelConfirm, setCancelConfirm] = useState(null);
  const [expandedNotes, setExpandedNotes] = useState(null);

  if (isClosed) return (
    <div style={{ padding: "32px", textAlign: "center", color: T.red, fontSize: "14px", fontWeight: 500 }}>
      {isHolidayClosed(ds) || isDateClosed(ds, settings) ? "Closed — Holiday" : "Closed — Weekend (enable in Settings → Weekend Hours)"}
    </div>
  );

  return (
    <div style={{ padding: "16px" }}>
      {getTimeSlots(settings).map(slot => {
        const bays = Array.from({ length: effectiveBays }, (_, i) => {
          const bay = i + 1;
          const bk = dayBks.find(b => b.bay === bay && slot.value >= b.hour && slot.value < b.hour + getBkDuration(b, getServices(settings)));
          return { bay, bk };
        });
        return (
          <div key={slot.value} style={{ marginBottom: "14px" }}>
            <div style={{ fontSize: "11px", fontWeight: 700, color: T.gray, textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: "6px" }}>{slot.label}</div>
            <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
              {bays.map(({ bay, bk }) => (
                <div key={bay} style={{ flex: 1, minWidth: "140px", padding: "10px 12px", borderRadius: "6px", background: bk ? (bk.status === "completed" ? "#F0FDF4" : T.yellowBg) : T.offWhite, border: `1px solid ${bk ? (bk.status === "completed" ? "#86EFAC" : T.yellow + "66") : T.lightGray}`, minHeight: "56px" }}>
                  <div style={{ fontSize: "10px", fontWeight: 700, color: bk ? (bk.status === "completed" ? "#22C55E" : T.yellow) : "#ccc", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: "4px" }}>Bay {bay}</div>
                  {bk ? (
                    <>
                      <div style={{ fontWeight: 600, fontSize: "13px" }}>{bk.name}</div>
                      <div style={{ fontSize: "11px", color: T.gray, marginTop: "1px" }}>{bk.year} {bk.make} {bk.model}</div>
                      <div style={{ fontSize: "11px", color: T.yellow, marginTop: "2px", fontWeight: 500 }}>{getBkNames(bk, getServices(settings))}</div>

                      {bk.notes && (
                        <div style={{ marginTop: "5px" }}>
                          <button onClick={() => setExpandedNotes(expandedNotes === bk.id ? null : bk.id)}
                            style={{ border: "none", background: "none", cursor: "pointer", fontSize: "11px", color: T.gray, padding: 0, fontFamily: "inherit", textDecoration: "underline" }}>
                            {expandedNotes === bk.id ? "Hide note" : "📝 Note"}
                          </button>
                          {expandedNotes === bk.id && (
                            <div style={{ fontSize: "11px", color: T.black, background: T.white, border: `1px solid ${T.lightGray}`, borderRadius: "4px", padding: "5px 7px", marginTop: "4px", fontStyle: "italic" }}>
                              "{bk.notes}"
                            </div>
                          )}
                        </div>
                      )}

                      {bk.status !== "completed" && !bk.isBlock && onCancel && (
                        <div style={{ marginTop: "7px" }}>
                          {cancelConfirm === bk.id ? (
                            <div style={{ display: "flex", gap: "4px" }}>
                              <button onClick={() => { onCancel(bk.id); setCancelConfirm(null); }}
                                style={{ border: "none", background: T.red, color: T.white, borderRadius: "4px", padding: "3px 8px", fontSize: "10px", fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>Confirm</button>
                              <button onClick={() => setCancelConfirm(null)}
                                style={{ border: `1px solid ${T.lightGray}`, background: T.white, color: T.gray, borderRadius: "4px", padding: "3px 8px", fontSize: "10px", cursor: "pointer", fontFamily: "inherit" }}>Keep</button>
                            </div>
                          ) : (
                            <button onClick={() => setCancelConfirm(bk.id)}
                              style={{ border: `1px solid ${T.lightGray}`, background: T.white, color: T.gray, borderRadius: "4px", padding: "3px 10px", fontSize: "10px", cursor: "pointer", fontFamily: "inherit" }}>
                              Cancel appt.
                            </button>
                          )}
                        </div>
                      )}
                    </>
                  ) : (
                    <button onClick={() => onAdd(ds, slot.value, bay)} style={{ border: "none", background: "none", cursor: "pointer", color: "#bbb", fontSize: "13px", padding: 0, display: "flex", alignItems: "center", gap: "4px", fontFamily: "inherit" }}>
                      <span style={{ width: "18px", height: "18px", borderRadius: "50%", border: `1px dashed #ccc`, display: "flex", alignItems: "center", justifyContent: "center", fontSize: "14px", lineHeight: 1 }}>+</span>
                      <span style={{ fontSize: "12px" }}>Add</span>
                    </button>
                  )}
                </div>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function CalWeekView({ date, bookings, settings, setDate, setView, onAdd }) {
  const ws = getWeekStart(date);
  const daysToShow = 5 + (settings?.openSaturday ? 1 : 0) + (settings?.openSunday ? 1 : 0);
  const days = Array.from({ length: daysToShow }, (_, i) => addDays(ws, i));

  return (
    <div style={{ overflowX: "auto" }}>
      <div style={{ minWidth: "560px" }}>
        {/* Day headers */}
        <div style={{ display: "grid", gridTemplateColumns: "56px repeat(5, 1fr)", borderBottom: `1px solid ${T.offWhite}` }}>
          <div />
          {days.map(d => {
            const ds = toDateStr(d), isToday = ds === todayStr(), closed = isWeekendClosed(ds, settings) || isDateClosed(ds, settings);
            return (
              <div key={ds} style={{ padding: "8px 4px", textAlign: "center", background: closed ? "#FFF8F8" : "transparent" }}>
                <div style={{ fontSize: "10px", color: T.gray, textTransform: "uppercase", letterSpacing: "0.06em" }}>{d.toLocaleDateString("en-US", { weekday: "short" })}</div>
                <div onClick={() => { if (!closed) { setDate(d); setView("day"); } }}
                  style={{ width: "26px", height: "26px", borderRadius: "50%", margin: "3px auto 0", display: "flex", alignItems: "center", justifyContent: "center", background: isToday ? T.yellow : "transparent", color: isToday ? T.white : closed ? T.red : T.black, fontWeight: isToday ? 700 : 500, fontSize: "13px", cursor: closed ? "default" : "pointer" }}>
                  {d.getDate()}
                </div>
                {closed && <div style={{ fontSize: "9px", color: T.red, marginTop: "2px" }}>Closed</div>}
              </div>
            );
          })}
        </div>
        {/* Time rows */}
        {getTimeSlots(settings).map(slot => (
          <div key={slot.value} style={{ display: "grid", gridTemplateColumns: "56px repeat(5, 1fr)", borderBottom: `1px solid ${T.offWhite}`, minHeight: "68px" }}>
            <div style={{ padding: "8px 8px 0 4px", fontSize: "10px", color: T.gray, fontFamily: "monospace", textAlign: "right" }}>{slot.short}</div>
            {days.map(d => {
              const ds = toDateStr(d), closed = isWeekendClosed(ds, settings) || isDateClosed(ds, settings);
              const bks = bookings.filter(b => b.date === ds && b.status === "confirmed" && b.hour === slot.value);
              const isEmpty = !closed && bks.length === 0;
              return (
                <div key={ds} style={{ padding: "4px 3px", borderLeft: `1px solid ${T.offWhite}`, background: closed ? "#FFF8F8" : "transparent", position: "relative" }}
                  onClick={() => isEmpty && onAdd(ds, slot.value)}>
                  {bks.map(bk => (
                    <div key={bk.id} style={{ background: T.yellowBg, border: `1px solid ${T.yellow}44`, borderRadius: "4px", padding: "4px 6px", marginBottom: "2px" }}>
                      <div style={{ fontWeight: 600, fontSize: "11px", color: T.yellow, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{bk.name}</div>
                      <div style={{ fontSize: "10px", color: T.gray, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{getBkNames(bk)}</div>
                    </div>
                  ))}
                  {isEmpty && (
                    <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", opacity: 0, transition: "opacity 0.1s", cursor: "pointer" }}
                      onMouseEnter={e => e.currentTarget.style.opacity = 1}
                      onMouseLeave={e => e.currentTarget.style.opacity = 0}>
                      <span style={{ fontSize: "18px", color: T.yellow, fontWeight: 300 }}>+</span>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

function CalMonthView({ date, bookings, settings, setDate, setView }) {
  const year = date.getFullYear(), month = date.getMonth();
  const firstDay = new Date(year, month, 1);
  const lastDay  = new Date(year, month + 1, 0);
  const startOffset = firstDay.getDay() === 0 ? 6 : firstDay.getDay() - 1;
  const gridStart = addDays(firstDay, -startOffset);
  const totalCells = Math.ceil((startOffset + lastDay.getDate()) / 7) * 7;
  const cells = Array.from({ length: totalCells }, (_, i) => addDays(gridStart, i));

  return (
    <div style={{ padding: "12px" }}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", marginBottom: "4px" }}>
        {["Mon","Tue","Wed","Thu","Fri","Sat","Sun"].map(d => (
          <div key={d} style={{ textAlign: "center", fontSize: "10px", fontWeight: 700, color: T.gray, textTransform: "uppercase", letterSpacing: "0.05em", padding: "4px" }}>{d}</div>
        ))}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: "3px" }}>
        {cells.map((d, i) => {
          const ds = toDateStr(d);
          const inMonth  = d.getMonth() === month;
          const isToday  = ds === todayStr();
          const isWkend  = isWeekendClosed(ds, settings);
          const closed   = inMonth && (isWkend || isDateClosed(ds, settings));
          const blocked  = isWkend || (inMonth && isDateClosed(ds, settings));
          const dayBks   = inMonth ? bookings.filter(b => b.date === ds && b.status === "confirmed") : [];
          const pendBks  = inMonth ? bookings.filter(b => b.date === ds && b.status === "pending")   : [];
          const clickable = inMonth && !blocked;

          return (
            <div key={i} onClick={() => { if (clickable) { setDate(d); setView("day"); } }}
              style={{ minHeight: "72px", borderRadius: "6px", padding: "6px", border: `1px solid ${isToday ? T.yellow : inMonth ? T.lightGray : "transparent"}`, background: !inMonth ? "transparent" : blocked ? T.offWhite : T.white, cursor: clickable ? "pointer" : "default", opacity: inMonth ? 1 : 0.25 }}>
              <div style={{ width: "22px", height: "22px", borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center", background: isToday ? T.yellow : "transparent", color: isToday ? T.white : blocked ? "#bbb" : T.black, fontWeight: isToday ? 700 : 400, fontSize: "12px", marginBottom: "3px" }}>
                {d.getDate()}
              </div>
              {closed && <div style={{ fontSize: "9px", color: T.red, fontWeight: 600, marginBottom: "2px" }}>Closed</div>}
              {dayBks.slice(0, 2).map(bk => (
                <div key={bk.id} style={{ fontSize: "10px", background: T.yellow, color: T.white, borderRadius: "3px", padding: "1px 5px", marginBottom: "2px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {bk.name.split(" ")[0]}
                </div>
              ))}
              {dayBks.length > 2 && <div style={{ fontSize: "9px", color: T.gray }}>+{dayBks.length - 2} more</div>}
              {pendBks.length > 0 && <div style={{ fontSize: "9px", color: "#92400E", background: "#FEF3C7", borderRadius: "3px", padding: "1px 4px", marginTop: "1px" }}>⏳ {pendBks.length}</div>}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Bay grid ──────────────────────────────────────────────────────────────────
function BayGrid({ bookings, date, effectiveBays = 3 }) {
  const todayBks = bookings.filter(b => b.status === "confirmed" && b.date === date);

  const occ = {};
  for (let bay = 1; bay <= effectiveBays; bay++) {
    occ[bay] = new Set();
    for (const b of todayBks.filter(bk => bk.bay === bay)) {
      const svcIds = b.serviceIds || [b.serviceId];
      const dur = svcIds.reduce((sum, id) => sum + (SERVICES.find(s => s.id === id)?.duration ?? 0), 0) || 1;
      for (let h = b.hour; h < b.hour + dur; h++) occ[bay].add(h);
    }
  }

  return (
    <div style={{ background: T.white, border: `1px solid ${T.lightGray}`, borderRadius: "8px", padding: "16px", marginBottom: "20px" }}>
      <p style={sectionLabel}>Today's Bay Schedule</p>
      <div style={{ overflowX: "auto" }}>
        <div style={{ minWidth: "480px" }}>
          {/* Time header */}
          <div style={{ display: "flex", marginLeft: "52px", marginBottom: "4px" }}>
            {getTimeSlots(settings).map(sl => (
              <div key={sl.value} style={{ flex: 1, textAlign: "center", fontSize: "10px", color: T.gray, fontFamily: "monospace" }}>{sl.short}</div>
            ))}
          </div>
          {/* Bay rows */}
          {Array.from({ length: effectiveBays }, (_, i) => i + 1).map(bay => (
            <div key={bay} style={{ display: "flex", alignItems: "center", gap: "4px", marginBottom: "5px" }}>
              <div style={{ width: "48px", fontSize: "10px", fontWeight: 700, color: T.gray, flexShrink: 0, textAlign: "right", paddingRight: "8px", fontFamily: "monospace", textTransform: "uppercase" }}>Bay {bay}</div>
              {getTimeSlots(settings).map(sl => {
                const occupied = occ[bay]?.has(sl.value);
                const svcs = getServices(settings);
                const booking  = todayBks.find(b => {
                  const dur = getBkDuration(b, svcs);
                  return b.bay === bay && sl.value >= b.hour && sl.value < b.hour + dur;
                });
                const isStart = booking?.hour === sl.value;
                return (
                  <div key={sl.value}
                    title={occupied && booking ? `${booking.name} — ${getBkNames(booking, svcs)}` : "Open"}
                    style={{ flex: 1, height: "28px", borderRadius: "4px", background: occupied ? T.yellow : T.offWhite, border: `1px solid ${occupied ? "#002A7A" : T.lightGray}`, display: "flex", alignItems: "center", justifyContent: "center", overflow: "hidden" }}>
                    {isStart && booking && (
                      <span style={{ fontSize: "9px", fontWeight: 700, color: T.white, padding: "0 3px", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: "100%" }}>
                        {booking.name.split(" ")[0]}
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      </div>
      <div style={{ marginTop: "10px", display: "flex", gap: "16px" }}>
        {[["Booked", T.yellow, "#002A7A"], ["Open", T.offWhite, T.lightGray]].map(([label, bg, border]) => (
          <div key={label} style={{ display: "flex", alignItems: "center", gap: "5px", fontSize: "11px", color: T.gray }}>
            <div style={{ width: "12px", height: "12px", background: bg, border: `1px solid ${border}`, borderRadius: "2px" }} />
            {label}
          </div>
        ))}
      </div>
    </div>
  );
}
