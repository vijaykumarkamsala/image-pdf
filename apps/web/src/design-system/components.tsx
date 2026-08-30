import {
  type ButtonHTMLAttributes,
  type ChangeEvent,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { AlertCircle, CheckCircle2, ChevronDown, File, Search, UploadCloud } from "lucide-react";

type ButtonTone = "primary" | "secondary" | "quiet" | "danger";

export function Button({
  tone = "secondary",
  size = "normal",
  className = "",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { tone?: ButtonTone; size?: "normal" | "compact" }) {
  return <button className={`ds-button ds-button-${tone} ds-button-${size} ${className}`.trim()} {...props} />;
}

export function IconButton({ label, className = "", ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return <button className={`ds-icon-button ${className}`.trim()} aria-label={label} title={label} {...props} />;
}

export function Tooltip({ label, children }: { label: string; children: ReactNode }) {
  return <span className="ds-tooltip" data-tooltip={label}>{children}</span>;
}

interface FieldShellProps {
  label: string;
  hint?: string;
  error?: string;
  inputId: string;
  children: ReactNode;
}

function FieldShell({ label, hint, error, inputId, children }: FieldShellProps) {
  const descriptionId = `${inputId}-description`;
  return (
    <div className="ds-field">
      <label htmlFor={inputId}>{label}</label>
      {children}
      {(error || hint) && <span id={descriptionId} className={error ? "ds-field-error" : "ds-field-hint"}>{error ?? hint}</span>}
    </div>
  );
}

export function TextInput({ label, hint, error, id, ...props }: InputHTMLAttributes<HTMLInputElement> & {
  label: string; hint?: string; error?: string;
}) {
  const generated = useId();
  const inputId = id ?? generated;
  return (
    <FieldShell label={label} hint={hint} error={error} inputId={inputId}>
      <input id={inputId} className="ds-input" aria-invalid={error ? true : undefined} aria-describedby={(error || hint) ? `${inputId}-description` : undefined} {...props} />
    </FieldShell>
  );
}

export function SelectField({ label, hint, error, id, children, ...props }: SelectHTMLAttributes<HTMLSelectElement> & {
  label: string; hint?: string; error?: string;
}) {
  const generated = useId();
  const inputId = id ?? generated;
  return (
    <FieldShell label={label} hint={hint} error={error} inputId={inputId}>
      <span className="ds-select-shell">
        <select id={inputId} className="ds-select" aria-invalid={error ? true : undefined} aria-describedby={(error || hint) ? `${inputId}-description` : undefined} {...props}>{children}</select>
        <ChevronDown aria-hidden="true" />
      </span>
    </FieldShell>
  );
}

export interface ComboboxOption { value: string; label: string; description?: string }

export function SearchCombobox({
  label,
  options,
  value,
  onChange,
  placeholder = "Search",
}: {
  label: string;
  options: ComboboxOption[];
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
}) {
  const id = useId();
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const filtered = useMemo(() => options.filter((option) => `${option.label} ${option.description ?? ""}`.toLowerCase().includes(query.toLowerCase())), [options, query]);
  const choose = (option: ComboboxOption) => {
    onChange(option.value);
    setQuery(option.label);
    setOpen(false);
  };
  return (
    <div className="ds-field ds-combobox">
      <label htmlFor={id}>{label}</label>
      <span className="ds-input-icon"><Search aria-hidden="true" /><input
        id={id}
        className="ds-input"
        role="combobox"
        aria-expanded={open}
        aria-controls={`${id}-listbox`}
        aria-autocomplete="list"
        value={query || options.find((option) => option.value === value)?.label || ""}
        placeholder={placeholder}
        onFocus={() => setOpen(true)}
        onChange={(event) => { setQuery(event.target.value); setOpen(true); setActive(0); }}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown") { event.preventDefault(); setOpen(true); setActive((current) => Math.min(filtered.length - 1, current + 1)); }
          if (event.key === "ArrowUp") { event.preventDefault(); setActive((current) => Math.max(0, current - 1)); }
          if (event.key === "Enter" && open && filtered[active]) { event.preventDefault(); choose(filtered[active]); }
          if (event.key === "Escape") setOpen(false);
        }}
      /></span>
      {open && <ul id={`${id}-listbox`} className="ds-combobox-list" role="listbox">
        {filtered.length === 0 && <li className="ds-combobox-empty">No matches</li>}
        {filtered.map((option, index) => <li key={option.value} role="option" aria-selected={option.value === value}>
          <button type="button" data-active={index === active} onMouseDown={(event) => event.preventDefault()} onClick={() => choose(option)}>
            <span>{option.label}</span>{option.description && <small>{option.description}</small>}
          </button>
        </li>)}
      </ul>}
    </div>
  );
}

export function Card({ children, className = "", interactive = false }: { children: ReactNode; className?: string; interactive?: boolean }) {
  return <div className={`ds-card${interactive ? " ds-card-interactive" : ""} ${className}`.trim()}>{children}</div>;
}

export function Badge({ children, tone = "neutral" }: { children: ReactNode; tone?: "neutral" | "brand" | "success" | "warning" | "error" | "info" }) {
  return <span className={`ds-badge ds-badge-${tone}`}>{children}</span>;
}

export function Progress({ value, label }: { value: number; label: string }) {
  return <div className="ds-progress"><div className="ds-progress-copy"><span>{label}</span><span>{Math.round(value)}%</span></div><progress aria-label={label} max={100} value={value} /></div>;
}

export interface TabItem { id: string; label: string; panel: ReactNode }

export function Tabs({ label, items, selected, onSelect }: { label: string; items: TabItem[]; selected: string; onSelect: (id: string) => void }) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  return <div className="ds-tabs"><div role="tablist" aria-label={label}>{items.map((item, index) => <button
    key={item.id}
    ref={(node) => { refs.current[index] = node; }}
    type="button"
    role="tab"
    aria-selected={selected === item.id}
    aria-controls={`${item.id}-panel`}
    id={`${item.id}-tab`}
    tabIndex={selected === item.id ? 0 : -1}
    onClick={() => onSelect(item.id)}
    onKeyDown={(event) => {
      if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
      event.preventDefault();
      const offset = event.key === 'ArrowRight' ? 1 : -1;
      const target = (index + offset + items.length) % items.length;
      onSelect(items[target].id);
      refs.current[target]?.focus();
    }}
  >{item.label}</button>)}</div>{items.map((item) => selected === item.id && <div key={item.id} role="tabpanel" id={`${item.id}-panel`} aria-labelledby={`${item.id}-tab`}>{item.panel}</div>)}</div>;
}

export function InlineNotice({ tone = "info", title, children }: { tone?: "info" | "success" | "warning" | "error"; title: string; children?: ReactNode }) {
  const Icon = tone === "success" ? CheckCircle2 : AlertCircle;
  return <div className={`ds-notice ds-notice-${tone}`} role={tone === "error" ? "alert" : "status"}><Icon aria-hidden="true" /><div><strong>{title}</strong>{children && <div>{children}</div>}</div></div>;
}

export function Skeleton({ width = "100%", height = 16 }: { width?: string; height?: number }) {
  return <span className="ds-skeleton" aria-hidden="true" style={{ width, height }} />;
}

export function Dropzone({
  label,
  description,
  accept,
  multiple = true,
  onFiles,
  compact = false,
}: {
  label: string;
  description: string;
  accept?: string;
  multiple?: boolean;
  compact?: boolean;
  onFiles: (files: File[]) => void;
}) {
  const id = useId();
  const [active, setActive] = useState(false);
  const handle = (files: FileList | null) => { if (files) onFiles(Array.from(files)); };
  return <label
    className={`ds-dropzone${active ? " is-active" : ""}${compact ? " is-compact" : ""}`}
    htmlFor={id}
    onDragEnter={(event) => { event.preventDefault(); setActive(true); }}
    onDragOver={(event) => event.preventDefault()}
    onDragLeave={() => setActive(false)}
    onDrop={(event) => { event.preventDefault(); setActive(false); handle(event.dataTransfer.files); }}
  >
    <UploadCloud aria-hidden="true" /><strong>{label}</strong><span>{description}</span><span className="ds-button ds-button-primary ds-button-normal">Choose files</span>
    <input id={id} type="file" accept={accept} multiple={multiple} onChange={(event: ChangeEvent<HTMLInputElement>) => { handle(event.target.files); event.target.value = ""; }} />
  </label>;
}

export function StatusItem({ icon, title, meta, status, tone = "neutral", actions, progress }: {
  icon?: ReactNode;
  title: string;
  meta: string;
  status: string;
  tone?: "neutral" | "success" | "warning" | "error" | "info";
  actions?: ReactNode;
  progress?: number;
}) {
  return <article className="ds-status-item"><span className={`ds-status-icon ds-status-${tone}`}>{icon ?? <File aria-hidden="true" />}</span><div className="ds-status-main"><div className="ds-status-head"><strong>{title}</strong><Badge tone={tone}>{status}</Badge></div><span>{meta}</span>{progress !== undefined && <Progress value={progress} label={`${title} progress`} />}</div>{actions && <div className="ds-status-actions">{actions}</div>}</article>;
}
