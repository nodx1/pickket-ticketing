import type { Metadata } from "next";

const CATEGORY_META: Record<string, { title: string; description: string }> = {
  concert: {
    title: "콘서트",
    description: "인기 콘서트 티켓을 공정하게 예매하세요",
  },
  sports: {
    title: "스포츠",
    description: "스포츠 경기 티켓을 공정 추첨으로 예매하세요",
  },
  musical: {
    title: "뮤지컬",
    description: "뮤지컬 공연 티켓을 공정하게 예매하세요",
  },
  classic: {
    title: "클래식",
    description: "클래식 공연 티켓을 공정 추첨으로 예매하세요",
  },
  festival: {
    title: "페스티벌",
    description: "페스티벌 티켓을 공정하게 예매하세요",
  },
  exhibition: {
    title: "전시",
    description: "전시회 티켓을 공정 추첨으로 예매하세요",
  },
  esports: {
    title: "e스포츠",
    description: "e스포츠 대회 티켓을 공정하게 예매하세요",
  },
  theater: {
    title: "연극",
    description: "연극 공연 티켓을 공정 추첨으로 예매하세요",
  },
};

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string; locale: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const meta = CATEGORY_META[slug] || {
    title: slug,
    description: `${slug} 카테고리의 이벤트를 확인하세요`,
  };

  return {
    title: `${meta.title} | Pickket`,
    description: meta.description,
    openGraph: {
      title: `${meta.title} — Pickket`,
      description: meta.description,
      type: "website",
    },
  };
}

export default function CategoryLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return children;
}
