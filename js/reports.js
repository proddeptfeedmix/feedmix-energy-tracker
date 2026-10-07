/* reports.js - builds the on-demand Feedmix-branded PDF report for a date range. */
const REPORTS = {
  generate(plantFilter, fromStr, toStr){
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF();
    const dates = STORE.dateRange(fromStr, toStr);
    const plants = plantFilter === "ALL" ? STORE.config.plants : STORE.config.plants.filter(p => p.id === plantFilter);

    doc.setFontSize(14);
    doc.text("Significant Electrical Load & Energy Consumption Report", 14, 16);
    doc.setFontSize(10);
    doc.text(`Period: ${fromStr} to ${toStr}`, 14, 23);
    doc.text(`Generated: ${new Date().toLocaleString()}`, 14, 28);
    doc.setFontSize(8);
    doc.text("Downtime = any time a machine is not running (24 h/day basis; today counts only the time elapsed so far).", 14, 33);
    doc.setFontSize(10);

    let y = 42;
    let grandTotalKWh = 0;

    plants.forEach(plant => {
      const machines = STORE.machinesForPlant(plant.id);
      let plantTotalKWh = 0, plantUpMs = 0, plantDownMs = 0;
      const pct = (up, down) => (up + down) > 0 ? (up / (up + down)) * 100 : 0;
      const rows = machines.map(m => {
        let kwh = 0;
        dates.forEach(d => {
          kwh += STORE.energyKWh(plant.id, m.id, d, m.ratedKW).kwh;
        });
        // Uptime/downtime on a 24h-per-day basis (anything not running = down).
        const u = STORE.uptimeStats(plant.id, m.id, fromStr, toStr);
        plantUpMs += u.upMs; plantDownMs += u.downMs; plantTotalKWh += kwh;
        return [m.name, m.category, m.ratedKW.toFixed(2),
          (u.upMs / 3600000).toFixed(2), (u.downMs / 3600000).toFixed(2),
          pct(u.upMs, u.downMs).toFixed(1) + "%", kwh.toFixed(2)];
      });
      grandTotalKWh += plantTotalKWh;

      if(y > 260){ doc.addPage(); y = 16; }
      doc.setFontSize(12);
      doc.text(`Plant: ${plant.name}`, 14, y); y += 6;
      doc.setFontSize(9);

      // simple manual table (no autotable dependency, keeps it lightweight)
      const colX = [14, 54, 84, 108, 132, 156, 174];
      const colW = [38, 28, 22, 22, 22, 16, 22]; // max text width per column (mm)
      const headers = ["Machine", "Category", "Rated kW", "Uptime (h)", "Downtime (h)", "Uptime %", "kWh"];
      doc.setFont(undefined, "bold");
      headers.forEach((h, i) => doc.text(h, colX[i], y));
      doc.setFont(undefined, "normal");
      y += 5;
      doc.line(14, y - 3, 196, y - 3);

      rows.forEach(row => {
        if(y > 275){ doc.addPage(); y = 16; }
        row.forEach((cell, i) => doc.text(doc.splitTextToSize(String(cell), colW[i])[0], colX[i], y));
        y += 5;
      });

      doc.setFont(undefined, "bold");
      doc.text(`Plant Total: Up ${(plantUpMs / 3600000).toFixed(2)} h, Down ${(plantDownMs / 3600000).toFixed(2)} h (${pct(plantUpMs, plantDownMs).toFixed(1)}% uptime), ${plantTotalKWh.toFixed(2)} kWh`, 14, y + 2);
      doc.setFont(undefined, "normal");
      y += 12;
    });

    if(y > 270){ doc.addPage(); y = 16; }
    doc.setFontSize(11);
    doc.setFont(undefined, "bold");
    doc.text(`Grand Total Energy: ${grandTotalKWh.toFixed(2)} kWh`, 14, y);

    const fname = `Feedmix_Energy_Report_${fromStr}_to_${toStr}.pdf`;
    doc.save(fname);
    return fname;
  }
};
