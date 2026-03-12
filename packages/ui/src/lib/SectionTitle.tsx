type SectionTitleProps = {
  eyebrow?: string;
  title: string;
  description: string;
};

export function SectionTitle({ eyebrow, title, description }: SectionTitleProps) {
  return (
    <div className="grid gap-1.5">
      {eyebrow ? (
        <span className="text-[11px] tracking-[0.16em] text-muted-foreground uppercase">
          {eyebrow}
        </span>
      ) : null}
      <h2 className="m-0 text-sm leading-tight font-semibold text-foreground">{title}</h2>
      <p className="m-0 text-[13px] leading-5 text-muted-foreground">{description}</p>
    </div>
  );
}
