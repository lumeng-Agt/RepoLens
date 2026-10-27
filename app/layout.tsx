import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "RepoLens — 仓库导览",
  description: "在只读工作区探索本地和 GitHub 代码库的目录、静态依赖、源码与阅读路线。",
  other: {
    "codex-preview": "development",
  },
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <head>
        {process.env.NODE_ENV === "development" && <script dangerouslySetInnerHTML={{ __html: `
          window.addEventListener("error", function(event) {
            if (event.message !== "ResizeObserver loop completed with undelivered notifications." || !document.querySelector(".react-flow")) return;
            event.preventDefault();
            event.stopImmediatePropagation();
            console.warn("[RepoLens] React Flow 的尺寸观察提示已记录；图谱交互与尺寸稳定性仍由回归检查。", event.message);
          }, true);
        ` }} />}
      </head>
      <body className="antialiased">{children}</body>
    </html>
  );
}
