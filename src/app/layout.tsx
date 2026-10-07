import type { Metadata } from "next";
import { cookies } from "next/headers";
import { Manrope, Outfit } from "next/font/google";
import { ThemeProvider } from "@/components/app/ThemeProvider";
import "./globals.css";

const outfit = Outfit({
  variable: "--font-display",
  subsets: ["latin"],
  weight: ["500", "600", "700"],
});

const manrope = Manrope({
  variable: "--font-body",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
});

export const metadata: Metadata = {
  title: "Custara",
  description: "Accounts payable, approvals, and controlled disbursement.",
  icons: {
    icon: [
      { url: "/favicon.ico", sizes: "any" },
      { url: "/favicon-32.png", sizes: "32x32", type: "image/png" },
      { url: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { url: "/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
    apple: [{ url: "/apple-touch-icon.png", sizes: "180x180" }],
  },
};

export default async function RootLayout({ children }: LayoutProps<"/">) {
  const cookieStore = await cookies();
  const raw = cookieStore.get("custara-theme")?.value;
  const theme = raw === "dark" || raw === "light" ? raw : "light";

  return (
    <html
      lang="en"
      className={`${outfit.variable} ${manrope.variable} ${theme} h-full antialiased`}
      style={{ colorScheme: theme }}
      suppressHydrationWarning
    >
      <body className="min-h-full font-sans text-foreground">
        <ThemeProvider initialTheme={theme}>{children}</ThemeProvider>
      </body>
    </html>
  );
}
