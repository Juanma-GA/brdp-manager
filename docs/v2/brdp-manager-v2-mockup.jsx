import { useState, useMemo } from "react";
import {
  FolderKanban, Settings, ChevronLeft, Users, FileText, Sparkles,
  Check, X, ShieldCheck, Database, Download, RotateCcw, ClipboardList,
  FileCode2, MessageSquare, PenLine, FileEdit, Gavel, ChevronDown,
  CircleUserRound, Plus, Search, Loader2
} from "lucide-react";

/* ---------------------------------------------------------------------
   Design tokens — paleta ATEXIS (branding.md del AACF), no genérica
--------------------------------------------------------------------- */
const C = {
  primary: "#2E74B5",
  primaryLight: "#4A8CCB",
  primaryDark: "#245C90",
  bg: "#FFFFFF",
  surface: "#F8FAFC",
  border: "#E2E8F0",
  borderStrong: "#CBD5E1",
  textPrimary: "#0F172A",
  textSecondary: "#64748B",
  textDisabled: "#94A3B8",
  success: "#16A34A",
  successBg: "#EAF7EF",
  warning: "#D97706",
  warningBg: "#FDF3E7",
  error: "#DC2626",
  errorBg: "#FCEAEA",
  info: "#2563EB",
};

const FONT = "'Inter', system-ui, -apple-system, sans-serif";
const MONO = "'JetBrains Mono', ui-monospace, 'SF Mono', monospace";

/* ---------------------------------------------------------------------
   Datos de demo
--------------------------------------------------------------------- */
const PERSONAS = {
  admin: { name: "Marta Ibáñez", role: "Administrador", email: "m.ibanez@atexis.example", projectIds: [1, 2, 3, 4] },
  editor: { name: "Carlos Ruiz", role: "Editor", email: "c.ruiz@atexis.example", projectIds: [1, 2] },
  viewer: { name: "Sara Molina", role: "Solo lectura", email: "s.molina@auditoria.example", projectIds: [4] },
};

const PROJECTS = [
  { id: 1, name: "Falcon MRO Manual", standard: "S1000D 4.2", brdpCount: 214 },
  { id: 2, name: "Atlas Cargo — Structural Repair", standard: "S1000D 3.0.1", brdpCount: 87 },
  { id: 3, name: "Meridian Naval Systems", standard: "DITA 1.3", brdpCount: 156 },
  { id: 4, name: "Condor UAV Platform", standard: "S1000D 4.1", brdpCount: 42 },
];

const BRDPS = {
  1: [
    { id: "BRDP-S1-00118", title: "Torque values in structural repair tasks", status: "Validated" },
    { id: "BRDP-S1-00119", title: "Use of illustrated parts data in task steps", status: "Validated" },
    { id: "BRDP-S1-00120", title: "Mandatory warnings before fuel system tasks", status: "Pending" },
    { id: "BRDP-S1-00121", title: "Applicability statements at topic level", status: "Pending" },
    { id: "BRDP-S1-00122", title: "Cross-references to IPD from procedural steps", status: "Refused" },
    { id: "BRDP-S1-00123", title: "Security classification on all data modules", status: "Validated" },
  ],
};

const STEP_LABELS = {
  definition: ["Leyendo la BRDP seleccionada", "Buscando 10 BRDPs aprobadas más similares (mismo estándar)", "Redactando definición sugerida"],
  proposal: ["Leyendo la BRDP seleccionada", "Buscando 10 BRDPs aprobadas más similares (mismo estándar)", "Redactando propuesta sugerida"],
  rule: ["Leyendo la BRDP seleccionada", "Buscando 10 BRDPs aprobadas más similares (mismo estándar)", "Redactando regla sugerida"],
};

const SUGGESTIONS = {
  definition: "Todo módulo de datos de tipo procedural debe declarar valores de par de apriete en unidades SI, con la tolerancia entre paréntesis, inmediatamente después del paso que requiere la sujeción.",
  proposal: "Añadir <torqueValue> con atributo unitOfMeasure obligatorio en el esquema de reglas de negocio; rechazar la generación si el valor aparece solo en texto libre dentro de <step>.",
  rule: "<structureObjectRule>\n  <objectPath>//step[.//torqueValue]</objectPath>\n  <objectUse>El par de apriete debe declararse en &lt;torqueValue&gt;, nunca en texto libre.</objectUse>\n</structureObjectRule>",
};

/* ---------------------------------------------------------------------
   Bloques de UI reutilizables
--------------------------------------------------------------------- */
function Badge({ children, tone = "neutral" }) {
  const tones = {
    neutral: { bg: C.surface, fg: C.textSecondary, bd: C.border },
    success: { bg: C.successBg, fg: "#0F5C31", bd: "#BFE6CD" },
    warning: { bg: C.warningBg, fg: "#8A5209", bd: "#F2D6A8" },
    error: { bg: C.errorBg, fg: "#8F1D1D", bd: "#F3C0C0" },
    primary: { bg: "#EAF2FA", fg: C.primaryDark, bd: "#C7DDF0" },
  };
  const t = tones[tone];
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", gap: 4, fontSize: 12, fontWeight: 600,
      padding: "2px 8px", borderRadius: 999, background: t.bg, color: t.fg, border: `1px solid ${t.bd}`,
      whiteSpace: "nowrap",
    }}>{children}</span>
  );
}

function StatusBadge({ status }) {
  const map = { Validated: ["success", "Validada"], Pending: ["warning", "Pendiente"], Refused: ["error", "Rechazada"] };
  const [tone, label] = map[status] || ["neutral", status];
  return <Badge tone={tone}>{label}</Badge>;
}

function Button({ children, onClick, variant = "secondary", disabled, icon: Icon, style }) {
  const base = {
    display: "inline-flex", alignItems: "center", gap: 6, fontSize: 13.5, fontWeight: 600,
    padding: "7px 12px", borderRadius: 8, cursor: disabled ? "not-allowed" : "pointer",
    border: "1px solid transparent", fontFamily: FONT, transition: "background 120ms, opacity 120ms",
    opacity: disabled ? 0.5 : 1,
  };
  const variants = {
    primary: { background: C.primary, color: "#fff" },
    secondary: { background: "#fff", color: C.textPrimary, border: `1px solid ${C.borderStrong}` },
    ghost: { background: "transparent", color: C.textSecondary },
    danger: { background: "#fff", color: C.error, border: `1px solid ${C.error}` },
  };
  return (
    <button disabled={disabled} onClick={disabled ? undefined : onClick} style={{ ...base, ...variants[variant], ...style }}>
      {Icon && <Icon size={15} strokeWidth={2} />}
      {children}
    </button>
  );
}

function Card({ title, subtitle, children, right }) {
  return (
    <div style={{ background: "#fff", border: `1px solid ${C.border}`, borderRadius: 10, marginBottom: 16 }}>
      {(title || right) && (
        <div style={{
          display: "flex", justifyContent: "space-between", alignItems: "center",
          padding: "14px 18px", borderBottom: `1px solid ${C.border}`,
        }}>
          <div>
            <div style={{ fontSize: 14.5, fontWeight: 700, color: C.textPrimary }}>{title}</div>
            {subtitle && <div style={{ fontSize: 12.5, color: C.textSecondary, marginTop: 2 }}>{subtitle}</div>}
          </div>
          {right}
        </div>
      )}
      <div style={{ padding: 18 }}>{children}</div>
    </div>
  );
}

function Field({ label, value, hint }) {
  return (
    <div style={{ marginBottom: 14 }}>
      <label style={{ display: "block", fontSize: 12.5, fontWeight: 600, color: C.textSecondary, marginBottom: 5 }}>{label}</label>
      <input defaultValue={value} readOnly={false} style={{
        width: "100%", boxSizing: "border-box", padding: "8px 10px", borderRadius: 7,
        border: `1px solid ${C.border}`, fontSize: 13.5, fontFamily: FONT, color: C.textPrimary, background: C.surface,
      }} />
      {hint && <div style={{ fontSize: 11.5, color: C.textDisabled, marginTop: 4 }}>{hint}</div>}
    </div>
  );
}

/* ---------------------------------------------------------------------
   Navegación izquierda
--------------------------------------------------------------------- */
function NavItem({ icon: Icon, label, active, onClick, indent }) {
  return (
    <div onClick={onClick} style={{
      display: "flex", alignItems: "center", gap: 9, padding: "8px 12px", marginLeft: indent ? 14 : 0,
      borderRadius: 7, cursor: "pointer", fontSize: 13.5, fontWeight: active ? 700 : 500,
      color: active ? C.primaryDark : C.textSecondary, background: active ? "#EAF2FA" : "transparent",
    }}>
      <Icon size={16} strokeWidth={2} />
      {label}
    </div>
  );
}

function Sidebar({ view, section, activeProject, onNavigate, onOpenProjects, onOpenSettings }) {
  return (
    <div style={{
      width: 236, flexShrink: 0, borderRight: `1px solid ${C.border}`, background: C.surface,
      padding: "16px 10px", display: "flex", flexDirection: "column", gap: 2, minHeight: 640,
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 8px 16px" }}>
        <div style={{
          width: 26, height: 26, borderRadius: 6, background: C.primary, color: "#fff",
          display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, fontWeight: 800,
        }}>B</div>
        <div style={{ fontSize: 14, fontWeight: 800, color: C.textPrimary }}>BRDP Manager</div>
      </div>

      <NavItem icon={FolderKanban} label="BRDP Projects" active={view === "projects"} onClick={onOpenProjects} />
      <NavItem icon={Settings} label="Settings" active={view === "settings"} onClick={onOpenSettings} />

      {view === "project" && activeProject && (
        <>
          <div style={{ height: 1, background: C.border, margin: "12px 6px" }} />
          <div onClick={onOpenProjects} style={{
            display: "flex", alignItems: "center", gap: 6, padding: "4px 8px 10px", fontSize: 12,
            color: C.textSecondary, cursor: "pointer", fontWeight: 600,
          }}>
            <ChevronLeft size={14} /> Todos los proyectos
          </div>
          <div style={{ padding: "0 8px 8px", fontSize: 13, fontWeight: 800, color: C.textPrimary, lineHeight: 1.3 }}>
            {activeProject.name}
          </div>
          <div style={{ padding: "0 8px 10px" }}><Badge tone="primary">{activeProject.standard}</Badge></div>

          <NavItem icon={ClipboardList} label="Project Configuration" active={section === "config"} onClick={() => onNavigate("config")} indent />
          <NavItem icon={FileText} label="BRDP Records" active={section === "records"} onClick={() => onNavigate("records")} indent />
          <NavItem icon={FileCode2} label="Generate BREX / Schematron" active={section === "generate"} onClick={() => onNavigate("generate")} indent />
        </>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------------
   Página: BRDP Projects (listado)
--------------------------------------------------------------------- */
function ProjectsPage({ projects, onOpen }) {
  return (
    <div>
      <h1 style={{ fontSize: 20, fontWeight: 800, color: C.textPrimary, margin: "0 0 4px" }}>BRDP Projects</h1>
      <p style={{ fontSize: 13.5, color: C.textSecondary, margin: "0 0 20px" }}>
        Proyectos asignados a tu usuario. Cada uno se gestiona de forma independiente.
      </p>

      {projects.length === 0 ? (
        <div style={{ padding: 40, textAlign: "center", color: C.textSecondary, border: `1px dashed ${C.border}`, borderRadius: 10 }}>
          No tienes proyectos asignados todavía. Pide a un administrador que te añada a uno.
        </div>
      ) : (
        <div style={{ border: `1px solid ${C.border}`, borderRadius: 10, overflow: "hidden" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13.5 }}>
            <thead>
              <tr style={{ background: C.surface, textAlign: "left" }}>
                <th style={th}>Project name</th>
                <th style={th}>Project standard</th>
                <th style={{ ...th, textAlign: "right" }}>Number of BRDP</th>
                <th style={{ ...th, textAlign: "right" }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {projects.map((p) => (
                <tr key={p.id} style={{ borderTop: `1px solid ${C.border}` }}>
                  <td style={{ ...td, fontWeight: 700, color: C.textPrimary }}>{p.name}</td>
                  <td style={td}><Badge tone="primary">{p.standard}</Badge></td>
                  <td style={{ ...td, textAlign: "right", fontFamily: MONO }}>{p.brdpCount}</td>
                  <td style={{ ...td, textAlign: "right" }}>
                    <div style={{ display: "inline-flex", gap: 6 }}>
                      <Button variant="ghost" icon={ClipboardList} onClick={() => onOpen(p, "config")}>Config</Button>
                      <Button variant="ghost" icon={FileText} onClick={() => onOpen(p, "records")}>Records</Button>
                      <Button variant="ghost" icon={FileCode2} onClick={() => onOpen(p, "generate")}>Generate</Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
const th = { padding: "10px 14px", fontSize: 12, fontWeight: 700, color: C.textSecondary, textTransform: "none" };
const td = { padding: "12px 14px", color: C.textPrimary };

/* ---------------------------------------------------------------------
   Página: Project Configuration
--------------------------------------------------------------------- */
function ProjectConfigPage({ project }) {
  return (
    <div>
      <PageHeader title="Project Configuration" subtitle={`${project.name} · ${project.standard}`} />
      <Card title="Metadatos del proyecto">
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0 20px" }}>
          <Field label="Project name" value={project.name} />
          <Field label="Model ident code" value="FLC" hint="CAGE code" />
          <Field label="System diff code" value="A" />
          <Field label="Issue number" value="001" />
          <Field label="Language / country" value="en-GB" />
          <Field label="Security classification" value="01 — Unclassified" />
        </div>
      </Card>

      <Card title="Data Management" subtitle="Import / export de BRDPs para este proyecto">
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <Button variant="secondary" icon={Database}>Import Excel</Button>
          <Button variant="secondary" icon={Download}>Export current BRDPs</Button>
          <Button variant="danger" icon={RotateCcw}>Reset data</Button>
        </div>
      </Card>
    </div>
  );
}

/* ---------------------------------------------------------------------
   Página: Generate BREX / Schematron
--------------------------------------------------------------------- */
function GeneratePage({ project }) {
  return (
    <div>
      <PageHeader title="Generate BREX / Schematron" subtitle={`${project.name} · ${project.standard}`} />
      <Card title={`Generar ${project.standard}`} subtitle="El formato está fijado por el estándar del proyecto.">
        <p style={{ fontSize: 13.5, color: C.textSecondary, marginTop: 0 }}>
          Se generará a partir de las {project.brdpCount} BRDP validadas de este proyecto. Ninguna BRDP se pierde:
          la que no pueda expresarse como regla ejecutable se incluye como entrada de trazabilidad.
        </p>
        <Button variant="primary" icon={FileCode2}>Generate {project.standard}</Button>
      </Card>
      <Card title="Historial reciente">
        {[
          { name: `${project.standard} — 2026-09-05.xml`, brdps: project.brdpCount },
          { name: `${project.standard} — 2026-08-22.xml`, brdps: project.brdpCount - 6 },
        ].map((h) => (
          <div key={h.name} style={{
            display: "flex", justifyContent: "space-between", padding: "9px 0",
            borderBottom: `1px solid ${C.border}`, fontSize: 13,
          }}>
            <span style={{ fontFamily: MONO }}>{h.name}</span>
            <span style={{ color: C.textSecondary }}>{h.brdps} BRDPs cubiertas</span>
          </div>
        ))}
      </Card>
    </div>
  );
}

function PageHeader({ title, subtitle }) {
  return (
    <div style={{ marginBottom: 18 }}>
      <h1 style={{ fontSize: 20, fontWeight: 800, color: C.textPrimary, margin: "0 0 4px" }}>{title}</h1>
      <p style={{ fontSize: 13, color: C.textSecondary, margin: 0 }}>{subtitle}</p>
    </div>
  );
}

/* ---------------------------------------------------------------------
   Página: BRDP Records (+ BRDP Assistant agéntico)
--------------------------------------------------------------------- */
function RecordsPage({ project }) {
  const rows = BRDPS[project.id] || BRDPS[1];
  const [checked, setChecked] = useState(() => new Set([rows[0].id]));
  const [selected, setSelected] = useState(rows[0].id);
  const [mode, setMode] = useState("generic");
  const [runState, setRunState] = useState({}); // { definition: 'running'|'done', ... }
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState(null);

  const toggleCheck = (id) => {
    setChecked((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  const runAgentic = (kind) => {
    setRunState((s) => ({ ...s, [kind]: 0 }));
    STEP_LABELS[kind].forEach((_, i) => {
      setTimeout(() => setRunState((s) => ({ ...s, [kind]: i + 1 })), (i + 1) * 550);
    });
  };

  const askGeneric = () => {
    if (!question.trim()) return;
    setAnswer(`Respondiendo solo con las ${checked.size} BRDP preseleccionadas: ${[...checked].join(", ")}.`);
  };

  const selectedRow = rows.find((r) => r.id === selected);

  return (
    <div>
      <PageHeader title="BRDP Records" subtitle={`${project.name} · ${project.standard} · ${rows.length} de ${project.brdpCount} mostradas`} />
      <div style={{ display: "flex", gap: 16, alignItems: "flex-start" }}>
        {/* tabla */}
        <div style={{ flex: 1, border: `1px solid ${C.border}`, borderRadius: 10, overflow: "hidden" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead>
              <tr style={{ background: C.surface }}>
                <th style={{ ...th, width: 30 }}></th>
                <th style={th}>ID</th>
                <th style={th}>Title</th>
                <th style={th}>Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}
                  onClick={() => setSelected(r.id)}
                  style={{
                    borderTop: `1px solid ${C.border}`, cursor: "pointer",
                    background: selected === r.id ? "#EAF2FA" : "transparent",
                  }}>
                  <td style={td} onClick={(e) => e.stopPropagation()}>
                    <input type="checkbox" checked={checked.has(r.id)} onChange={() => toggleCheck(r.id)} />
                  </td>
                  <td style={{ ...td, fontFamily: MONO, fontSize: 12 }}>{r.id}</td>
                  <td style={td}>{r.title}</td>
                  <td style={td}><StatusBadge status={r.status} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* BRDP Assistant */}
        <div style={{ width: 340, flexShrink: 0, border: `1px solid ${C.border}`, borderRadius: 10, overflow: "hidden" }}>
          <div style={{ padding: "12px 14px", borderBottom: `1px solid ${C.border}`, background: C.surface, display: "flex", alignItems: "center", gap: 7 }}>
            <Sparkles size={15} color={C.primary} />
            <span style={{ fontSize: 13.5, fontWeight: 700 }}>BRDP Assistant</span>
          </div>

          <div style={{ display: "flex", borderBottom: `1px solid ${C.border}` }}>
            {[
              ["generic", "Questions", MessageSquare],
              ["definition", "Definition", PenLine],
              ["proposal", "Proposal", FileEdit],
              ["rule", "Rule", Gavel],
            ].map(([key, label, Icon]) => (
              <div key={key} onClick={() => setMode(key)} style={{
                flex: 1, textAlign: "center", padding: "8px 2px", fontSize: 11, fontWeight: 700, cursor: "pointer",
                color: mode === key ? C.primaryDark : C.textSecondary,
                borderBottom: mode === key ? `2px solid ${C.primary}` : "2px solid transparent",
              }}>
                <Icon size={14} style={{ display: "block", margin: "0 auto 3px" }} />
                {label}
              </div>
            ))}
          </div>

          <div style={{ padding: 14 }}>
            {mode === "generic" && (
              <>
                <p style={{ fontSize: 12, color: C.textSecondary, marginTop: 0 }}>
                  Responde solo sobre las <b>{checked.size} BRDP</b> marcadas con checkbox en la tabla.
                </p>
                <textarea value={question} onChange={(e) => setQuestion(e.target.value)}
                  placeholder="¿Por qué esta BRDP quedó pendiente?"
                  style={{ width: "100%", boxSizing: "border-box", minHeight: 60, padding: 8, borderRadius: 7, border: `1px solid ${C.border}`, fontSize: 12.5, fontFamily: FONT, resize: "vertical" }} />
                <Button variant="primary" style={{ marginTop: 8, width: "100%", justifyContent: "center" }} onClick={askGeneric} disabled={checked.size === 0}>
                  Preguntar
                </Button>
                {answer && (
                  <div style={{ marginTop: 10, padding: 10, borderRadius: 7, background: C.surface, fontSize: 12.5, color: C.textPrimary }}>
                    {answer}
                  </div>
                )}
              </>
            )}

            {["definition", "proposal", "rule"].includes(mode) && (
              <AgenticPanel
                kind={mode}
                selectedRow={selectedRow}
                progress={runState[mode]}
                onRun={() => runAgentic(mode)}
              />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function AgenticPanel({ kind, selectedRow, progress, onRun }) {
  const steps = STEP_LABELS[kind];
  const running = progress !== undefined && progress < steps.length;
  const done = progress === steps.length;

  return (
    <div>
      <p style={{ fontSize: 12, color: C.textSecondary, marginTop: 0 }}>
        Para: <span style={{ fontFamily: MONO, color: C.textPrimary }}>{selectedRow?.id || "—"}</span>
      </p>
      {!selectedRow ? (
        <p style={{ fontSize: 12, color: C.textDisabled }}>Selecciona una fila de la tabla.</p>
      ) : (
        <>
          <Button variant="primary" icon={progress === undefined ? Sparkles : undefined}
            style={{ width: "100%", justifyContent: "center" }}
            onClick={onRun} disabled={running}>
            {running ? <Loader2 size={14} className="spin" /> : null}
            {progress === undefined ? `Suggest ${kind === "definition" ? "Definition" : kind === "proposal" ? "Proposal" : "Rule"}` : running ? "Trabajando…" : "Repetir"}
          </Button>

          {progress !== undefined && (
            <div style={{ marginTop: 10 }}>
              {steps.map((s, i) => (
                <div key={s} style={{ display: "flex", alignItems: "center", gap: 7, fontSize: 12, padding: "4px 0", color: i < progress ? C.textPrimary : C.textDisabled }}>
                  {i < progress ? <Check size={13} color={C.success} /> : i === progress ? <Loader2 size={13} className="spin" /> : <span style={{ width: 13 }} />}
                  {s}
                </div>
              ))}
            </div>
          )}

          {done && (
            <div style={{ marginTop: 10, padding: 10, borderRadius: 7, background: C.surface, border: `1px solid ${C.border}` }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: C.textSecondary, marginBottom: 6 }}>
                SUGERENCIA (basada en 10 BRDP aprobadas similares)
              </div>
              <div style={{ fontSize: 12.5, color: C.textPrimary, fontFamily: kind === "rule" ? MONO : FONT, whiteSpace: "pre-wrap", lineHeight: 1.5 }}>
                {SUGGESTIONS[kind]}
              </div>
              <div style={{ display: "flex", gap: 6, marginTop: 10 }}>
                <Button variant="primary" icon={Check}>Aceptar</Button>
                <Button variant="ghost" icon={X}>Descartar</Button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------------
   Página: Settings
--------------------------------------------------------------------- */
function SettingsPage({ persona, personaKey }) {
  const isAdmin = personaKey === "admin";
  return (
    <div>
      <PageHeader title="Settings" subtitle="Configuración de tu perfil. La configuración de cada proyecto vive dentro de BRDP Projects." />

      <Card title="Perfil">
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <div style={{ width: 40, height: 40, borderRadius: "50%", background: "#EAF2FA", display: "flex", alignItems: "center", justifyContent: "center" }}>
            <CircleUserRound size={22} color={C.primary} />
          </div>
          <div>
            <div style={{ fontWeight: 700, fontSize: 14 }}>{persona.name}</div>
            <div style={{ fontSize: 12.5, color: C.textSecondary }}>{persona.email}</div>
          </div>
          <div style={{ marginLeft: "auto" }}><Badge tone="primary">{persona.role}</Badge></div>
        </div>
      </Card>

      <Card title="AI Configuration" subtitle="Definida por administración de sistemas, no editable por usuario.">
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 12px", background: C.surface, borderRadius: 8 }}>
          <div>
            <div style={{ fontSize: 13, fontWeight: 700 }}>Motor activo: Qwen (self-hosted, UE)</div>
            <div style={{ fontSize: 11.5, color: C.textSecondary, marginTop: 2 }}>
              Configurado vía variable de entorno del servidor. Mistral queda comentado en .env para proyectos cuyos datos sí puedan salir de España.
            </div>
          </div>
          <ShieldCheck size={18} color={C.success} />
        </div>
      </Card>

      {isAdmin && (
        <Card title="User Management" subtitle="Solo visible para administradores" right={<Button variant="primary" icon={Plus}>Invite user</Button>}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead>
              <tr style={{ textAlign: "left" }}>
                <th style={th}>Name</th>
                <th style={th}>Role</th>
                <th style={th}>Assigned projects</th>
                <th style={th}></th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(PERSONAS).map(([key, u]) => (
                <tr key={key} style={{ borderTop: `1px solid ${C.border}` }}>
                  <td style={td}>
                    <div style={{ fontWeight: 600 }}>{u.name}</div>
                    <div style={{ fontSize: 11.5, color: C.textSecondary }}>{u.email}</div>
                  </td>
                  <td style={td}>
                    <span style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 12.5, color: C.textPrimary }}>
                      {u.role} <ChevronDown size={13} color={C.textDisabled} />
                    </span>
                  </td>
                  <td style={td}>
                    {u.projectIds.map((id) => PROJECTS.find((p) => p.id === id)?.name).join(", ")}
                  </td>
                  <td style={{ ...td, textAlign: "right" }}>
                    <Button variant="ghost">Editar</Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------------
   App
--------------------------------------------------------------------- */
export default function BRDPManagerMockup() {
  const [personaKey, setPersonaKey] = useState("admin");
  const [view, setView] = useState("projects"); // 'projects' | 'project' | 'settings'
  const [activeProjectId, setActiveProjectId] = useState(null);
  const [section, setSection] = useState("records");

  const persona = PERSONAS[personaKey];
  const myProjects = useMemo(() => PROJECTS.filter((p) => persona.projectIds.includes(p.id)), [persona]);
  const activeProject = PROJECTS.find((p) => p.id === activeProjectId);

  const openProject = (project, sec) => {
    setActiveProjectId(project.id);
    setSection(sec);
    setView("project");
  };

  return (
    <div style={{ fontFamily: FONT, color: C.textPrimary, border: `1px solid ${C.border}`, borderRadius: 12, overflow: "hidden", background: "#fff" }}>
      <style>{`
        @keyframes spin { to { transform: rotate(360deg); } }
        .spin { animation: spin 0.8s linear infinite; }
        table th { font-weight: 700; }
      `}</style>

      {/* barra de simulación de rol — no forma parte de la UI real, es para probar el mockup */}
      <div style={{
        display: "flex", alignItems: "center", gap: 10, padding: "8px 16px",
        background: "#0F172A", color: "#fff", fontSize: 12,
      }}>
        <Users size={13} />
        <span style={{ opacity: 0.75 }}>Viendo como:</span>
        {Object.entries(PERSONAS).map(([key, p]) => (
          <button key={key} onClick={() => { setPersonaKey(key); setView("projects"); }} style={{
            background: personaKey === key ? "#2E74B5" : "transparent",
            color: "#fff", border: `1px solid ${personaKey === key ? "#2E74B5" : "#334155"}`,
            borderRadius: 999, padding: "3px 10px", fontSize: 11.5, fontWeight: 600, cursor: "pointer",
          }}>{p.name} · {p.role}</button>
        ))}
      </div>

      <div style={{ display: "flex" }}>
        <Sidebar
          view={view} section={section} activeProject={activeProject}
          onNavigate={setSection}
          onOpenProjects={() => setView("projects")}
          onOpenSettings={() => setView("settings")}
        />
        <div style={{ flex: 1, padding: 24, minHeight: 640, background: "#fff" }}>
          {view === "projects" && <ProjectsPage projects={myProjects} onOpen={openProject} />}
          {view === "settings" && <SettingsPage persona={persona} personaKey={personaKey} />}
          {view === "project" && activeProject && section === "config" && <ProjectConfigPage project={activeProject} />}
          {view === "project" && activeProject && section === "records" && <RecordsPage project={activeProject} />}
          {view === "project" && activeProject && section === "generate" && <GeneratePage project={activeProject} />}
        </div>
      </div>
    </div>
  );
}
