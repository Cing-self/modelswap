interface SidebarSection {
  title?: string;
  items: SidebarItem[];
}

interface SidebarItem {
  key: string;
  label: string;
  count?: number;
  active?: boolean;
  indent?: boolean;
  onClick?: () => void;
}

export default function PageSidebar({ sections }: { sections: SidebarSection[] }) {
  return (
    <aside className="page-sidebar">
      {sections.map((sec, i) => (
        <div key={i} className="page-sidebar-section">
          {sec.title && <div className="page-sidebar-title">{sec.title}</div>}
          <div className="page-sidebar-items">
            {sec.items.map(item => (
              <div
                key={item.key}
                className={`page-sidebar-item${item.active ? ' active' : ''}${item.indent ? ' page-sidebar-item--indent' : ''}`}
                onClick={item.onClick}
              >
                <span>{item.label}</span>
                {item.count !== undefined && (
                  <span className="page-sidebar-count">{item.count}</span>
                )}
              </div>
            ))}
          </div>
        </div>
      ))}
    </aside>
  );
}
