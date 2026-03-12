type SectionTitleProps = {
  eyebrow?: string;
  title: string;
  description: string;
};

export function SectionTitle({ eyebrow, title, description }: SectionTitleProps) {
  return (
    <div className="pg-section-title">
      {eyebrow ? <span className="pg-section-title__eyebrow">{eyebrow}</span> : null}
      <h2 className="pg-section-title__title">{title}</h2>
      <p className="pg-section-title__description">{description}</p>
    </div>
  );
}
