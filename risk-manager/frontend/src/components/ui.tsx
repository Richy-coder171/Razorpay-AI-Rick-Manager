import type { ReactNode } from 'react';

/* ------------------------------------------------------------------ */
/* Card primitives                                                     */
/* ------------------------------------------------------------------ */

export function Card({
  children,
  className = '',
  hover = false,
}: {
  children: ReactNode;
  className?: string;
  hover?: boolean;
}) {
  return (
    <div
      className={`bg-white rounded-xl border border-slate-200/80 shadow-card ${
        hover ? 'transition-shadow duration-200 hover:shadow-card-hover' : ''
      } ${className}`}
    >
      {children}
    </div>
  );
}

export function CardHeader({
  title,
  subtitle,
  icon,
  actions,
  className = '',
}: {
  title: string;
  subtitle?: string;
  icon?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <div className={`flex items-start justify-between gap-4 px-6 pt-5 pb-4 ${className}`}>
      <div className="flex items-start gap-3 min-w-0">
        {icon && (
          <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-brand-50 text-brand-600">
            {icon}
          </div>
        )}
        <div className="min-w-0">
          <h3 className="text-base font-semibold text-slate-900 leading-tight">{title}</h3>
          {subtitle && <p className="mt-1 text-sm text-slate-500 leading-snug">{subtitle}</p>}
        </div>
      </div>
      {actions && <div className="shrink-0 flex items-center gap-2">{actions}</div>}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Page header                                                         */
/* ------------------------------------------------------------------ */

export function PageHeader({
  title,
  subtitle,
  badge,
  actions,
}: {
  title: string;
  subtitle?: string;
  badge?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-bold tracking-tight text-slate-900 sm:text-3xl">{title}</h1>
          {badge}
        </div>
        {subtitle && <p className="mt-1.5 text-sm text-slate-500 sm:text-base">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Badges & pills                                                      */
/* ------------------------------------------------------------------ */

const badgeTones = {
  gray: 'bg-slate-100 text-slate-700 ring-slate-200',
  green: 'bg-emerald-50 text-emerald-700 ring-emerald-200',
  red: 'bg-red-50 text-red-700 ring-red-200',
  orange: 'bg-orange-50 text-orange-700 ring-orange-200',
  blue: 'bg-brand-50 text-brand-700 ring-brand-200',
  purple: 'bg-violet-50 text-violet-700 ring-violet-200',
  yellow: 'bg-yellow-50 text-yellow-800 ring-yellow-200',
} as const;

export type BadgeTone = keyof typeof badgeTones;

export function Badge({
  children,
  tone = 'gray',
  className = '',
}: {
  children: ReactNode;
  tone?: BadgeTone;
  className?: string;
}) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ring-inset ${badgeTones[tone]} ${className}`}
    >
      {children}
    </span>
  );
}

export function ModuleBadge({ module, className = '' }: { module: string; className?: string }) {
  const map: Record<string, { label: string; tone: BadgeTone }> = {
    fraud_spike: { label: 'Fraud Spike', tone: 'red' },
    return_risk: { label: 'Return Risk', tone: 'yellow' },
    abuse_ring: { label: 'Abuse Ring', tone: 'purple' },
    chargeback: { label: 'Chargeback', tone: 'blue' },
  };
  const cfg = map[module] ?? { label: module, tone: 'gray' as BadgeTone };
  return (
    <Badge tone={cfg.tone} className={className}>
      {cfg.label}
    </Badge>
  );
}

export function ConfidenceBadge({ confidence }: { confidence: string }) {
  const tone: BadgeTone =
    confidence === 'high' ? 'green' : confidence === 'medium' ? 'orange' : 'red';
  const dot =
    confidence === 'high' ? 'bg-emerald-500' : confidence === 'medium' ? 'bg-orange-500' : 'bg-red-500';
  return (
    <Badge tone={tone}>
      <span className={`inline-block h-1.5 w-1.5 rounded-full ${dot}`} />
      {confidence.charAt(0).toUpperCase() + confidence.slice(1)}
    </Badge>
  );
}
/* ------------------------------------------------------------------ */
/* Buttons                                                             */
/* ------------------------------------------------------------------ */

const buttonVariants = {
  primary: 'bg-brand-600 text-white hover:bg-brand-700 focus-visible:outline-brand-600 shadow-sm',
  success: 'bg-emerald-600 text-white hover:bg-emerald-700 focus-visible:outline-emerald-600 shadow-sm',
  danger: 'bg-red-600 text-white hover:bg-red-700 focus-visible:outline-red-600 shadow-sm',
  warning: 'bg-amber-500 text-white hover:bg-amber-600 focus-visible:outline-amber-500 shadow-sm',
  purple: 'bg-violet-600 text-white hover:bg-violet-700 focus-visible:outline-violet-600 shadow-sm',
  secondary:
    'bg-white text-slate-700 border border-slate-300 hover:bg-slate-50 hover:text-slate-900 focus-visible:outline-slate-400 shadow-sm',
  ghost: 'text-slate-600 hover:bg-slate-100 hover:text-slate-900 focus-visible:outline-slate-400',
} as const;

export type ButtonVariant = keyof typeof buttonVariants;

const buttonSizes = {
  sm: 'px-2.5 py-1.5 text-xs gap-1.5',
  md: 'px-3.5 py-2 text-sm gap-2',
  lg: 'px-5 py-2.5 text-sm gap-2',
} as const;

export function Button({
  children,
  variant = 'primary',
  size = 'md',
  className = '',
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: 'sm' | 'md' | 'lg';
}) {
  return (
    <button
      {...rest}
      className={`inline-flex items-center justify-center rounded-lg font-medium transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 disabled:opacity-50 disabled:pointer-events-none ${buttonVariants[variant]} ${buttonSizes[size]} ${className}`}
    >
      {children}
    </button>
  );
}

/* ------------------------------------------------------------------ */
/* Stat card (dashboard KPI)                                            */
/* ------------------------------------------------------------------ */

const statToneMap = {
  blue: { chip: 'bg-brand-50 text-brand-600', bar: 'bg-brand-500' },
  green: { chip: 'bg-emerald-50 text-emerald-600', bar: 'bg-emerald-500' },
  red: { chip: 'bg-red-50 text-red-600', bar: 'bg-red-500' },
  orange: { chip: 'bg-amber-50 text-amber-600', bar: 'bg-amber-500' },
  purple: { chip: 'bg-violet-50 text-violet-600', bar: 'bg-violet-500' },
} as const;

export function StatCard({
  label,
  value,
  icon,
  tone = 'blue',
  hint,
  delay = 0,
}: {
  label: string;
  value: ReactNode;
  icon?: ReactNode;
  tone?: keyof typeof statToneMap;
  hint?: string;
  delay?: 0 | 1 | 2 | 3;
}) {
  const t = statToneMap[tone];
  const delayCls = ['', 'animate-slide-up-delay-1', 'animate-slide-up-delay-2', 'animate-slide-up-delay-3'][delay];
  return (
    <Card hover className={`p-5 ${delay ? delayCls : 'animate-slide-up'}`}>
      <div className="flex items-start justify-between">
        <div>
          <p className="text-sm font-medium text-slate-500">{label}</p>
          <p className="mt-2 text-3xl font-bold tracking-tight text-slate-900 tabular-nums">{value}</p>
          {hint && <p className="mt-1.5 text-xs text-slate-400">{hint}</p>}
        </div>
        {icon && (
          <div className={`flex h-10 w-10 items-center justify-center rounded-lg ${t.chip}`}>{icon}</div>
        )}
      </div>
      <div className="mt-4 h-1 rounded-full bg-slate-100">
        <div className={`h-1 w-10 rounded-full ${t.bar}`} />
      </div>
    </Card>
  );
}

/* ------------------------------------------------------------------ */
/* Risk meter — probability gauge with colored zones                     */
/* ------------------------------------------------------------------ */

export function RiskMeter({
  value,
  label = 'Risk probability',
  showValue = true,
  height = 'md',
}: {
  value: number;
  label?: string;
  showValue?: boolean;
  height?: 'sm' | 'md' | 'lg';
}) {
  const pct = Math.max(0, Math.min(100, value * 100));
  const zone =
    pct >= 75 ? 'bg-red-500' : pct >= 55 ? 'bg-orange-500' : pct >= 35 ? 'bg-amber-400' : 'bg-emerald-500';
  const heightCls = height === 'lg' ? 'h-3' : height === 'sm' ? 'h-1.5' : 'h-2';
  return (
    <div>
      {(showValue || label) && (
        <div className="mb-1.5 flex items-baseline justify-between">
          {label && <span className="text-xs font-medium text-slate-500">{label}</span>}
          {showValue && (
            <span className="text-sm font-semibold text-slate-900 tabular-nums">{pct.toFixed(1)}%</span>
          )}
        </div>
      )}
      <div className="relative w-full overflow-hidden rounded-full bg-slate-100">
        <div className={`relative w-full ${heightCls}`}>
          <div className="absolute inset-y-0 left-[35%] w-px bg-white/70" />
          <div className="absolute inset-y-0 left-[55%] w-px bg-white/70" />
          <div className="absolute inset-y-0 left-[75%] w-px bg-white/70" />
          <div
            className={`absolute inset-y-0 left-0 rounded-full ${zone} transition-all duration-700 ease-out`}
            style={{ width: `${pct}%` }}
          />
        </div>
      </div>
    </div>
  );
}
