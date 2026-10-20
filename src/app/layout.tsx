import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'LAN Chat',
  description: 'End-to-end encrypted chat between devices on the same Wi-Fi',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
