import { Noto_Sans_SC, Sora } from 'next/font/google';
import { Provider } from '@/components/provider';
import './global.css';

const bodyFont = Noto_Sans_SC({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  variable: '--font-body',
});

const displayFont = Sora({
  subsets: ['latin'],
  weight: ['500', '600', '700'],
  variable: '--font-display',
});

export default function Layout({ children }: LayoutProps<'/'>) {
  return (
    <html
      lang="zh-CN"
      className={`${bodyFont.className} ${bodyFont.variable} ${displayFont.variable}`}
      suppressHydrationWarning
    >
      <body className="flex flex-col min-h-screen">
        <Provider>{children}</Provider>
      </body>
    </html>
  );
}
