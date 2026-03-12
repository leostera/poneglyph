type SectionTitleProps = {
  title: string;
  description: string;
};

export function SectionTitle({ title, description }: SectionTitleProps) {
  return (
    <div>
      <h2 style={titleStyle}>{title}</h2>
      <p style={descriptionStyle}>{description}</p>
    </div>
  );
}

const titleStyle = {
  margin: 0,
  fontSize: "1.55rem",
  lineHeight: 1.1,
};

const descriptionStyle = {
  margin: "10px 0 0",
  color: "rgba(248, 241, 223, 0.68)",
  lineHeight: 1.6,
};
