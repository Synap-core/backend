const LOGO_SRC = `${import.meta.env.BASE_URL}logo.png`;

interface BrandMarkProps {
  /** Hide wordmark; show logo only (e.g. compact header). */
  compact?: boolean;
}

export default function BrandMark({ compact = false }: BrandMarkProps) {
  return (
    <div className="inline-flex items-center gap-2">
      <img
        src={LOGO_SRC}
        alt="Synap"
        width={32}
        height={32}
        className="h-8 w-8 shrink-0 rounded-lg object-contain"
        decoding="async"
      />
      {!compact ? (
        <div className="flex min-w-0 flex-col leading-tight">
          <span className="bg-linear-to-br from-primary to-secondary bg-clip-text text-base font-bold tracking-tight text-transparent">
            Synap
          </span>
          <span className="text-[10px] font-medium uppercase tracking-wider text-default-400">
            Pod admin
          </span>
        </div>
      ) : null}
    </div>
  );
}
