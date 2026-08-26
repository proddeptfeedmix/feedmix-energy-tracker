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

    let y = 38;
    let grandTotalKWh = 0;

    plants.forEach(plant => {
      const machines = STORE.machinesForPlant(plant.id);
      let plantTotalKWh = 0, plantTotalHours = 0;
      const rows = machines.map(m => {
        let hours = 0, kwh = 0;
        dates.forEach(d => {
          const r = STORE.energyKWh(plant.id, m.id, d, m.ratedKW);
          hours += r.hours; kwh += r.kwh;
        });
        plantTotalHours += hours; plantTotalKWh += kwh;
        return [m.name, m.category, m.ratedKW.toFixed(2), hours.toFixed(2), kwh.toFixed(2)];
      });
      grandTotalKWh += plantTotalKWh;

      if(y > 260){ doc.addPage(); y = 16; }
      doc.setFontSize(12);
      doc.text(`Plant: ${plant.name}`, 14, y); y += 6;
      doc.setFontSize(9);

      // simple manual table (no autotable dependency, keeps it lightweight)
      const colX = [14, 74, 114, 140, 166];
      const headers = ["Machine", "Category", "Rated kW", "Hours", "kWh"];
      doc.setFont(undefined, "bold");
      headers.forEach((h, i) => doc.text(h, colX[i], y));
      doc.setFont(undefined, "normal");
      y += 5;
      doc.line(14, y - 3, 196, y - 3);

      rows.forEach(row => {
        if(y > 275){ doc.addPage(); y = 16; }
        row.forEach((cell, i) => doc.text(String(cell), colX[i], y));
        y += 5;
      });

      doc.setFont(undefined, "bold");
      doc.text(`Plant Total: ${plantTotalHours.toFixed(2)} hrs, ${plantTotalKWh.toFixed(2)} kWh`, 14, y + 2);
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
