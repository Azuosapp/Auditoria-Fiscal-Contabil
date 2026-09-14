import { Sidebar } from "@/components/Sidebar";

export default function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="shell">
      <Sidebar />
      <div className="flex min-h-screen flex-col">
        <header className="hdr">
          <div className="text-[13px] font-bold">Auditoria Fiscal e Contábil</div>
          <div className="text-[10px] text-white/60">Analyze · Grupo Azuos</div>
        </header>
        <main className="main">{children}</main>
      </div>
    </div>
  );
}
