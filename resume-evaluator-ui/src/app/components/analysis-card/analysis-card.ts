import { Component, Input, computed, input } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Analysis } from '../../models';

interface ExperienceEntry {
  header: string;
  body: string;
}

@Component({
  selector: 'app-analysis-card',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './analysis-card.html',
  styleUrl: './analysis-card.css',
})
export class AnalysisCard {
  readonly analysis = input<Analysis | null>(null);

  protected trackByIndex(index: number, _item: unknown): number {
    return index;
  }

  protected readonly experienceItems = computed<ExperienceEntry[]>(() => {
    const raw = this.analysis()?.experience?.trim() ?? '';
    if (!raw) {
      return [];
    }

    const blocks: string[] = [];
    let current = '';

    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) {
        if (current) {
          current += '\n';
        }
        continue;
      }

      const startsNewEntry =
        /^[A-Z0-9][\w.&,'\- ]*\([^)]*\d{4}[^)]*\)/.test(trimmed);

      if (startsNewEntry && current.trim()) {
        blocks.push(current.trim());
        current = '';
      }

      current += (current ? '\n' : '') + trimmed;
    }

    if (current.trim()) {
      blocks.push(current.trim());
    }

    return blocks
      .filter((block) => block.length > 0)
      .map((block) => {
        const firstNewline = block.indexOf('\n');
        if (firstNewline === -1) {
          const match = block.match(/^(.*?\([^)]*\d{4}[^)]*\))\s*:\s*(.*)$/s);
          if (match) {
            return { header: match[1].trim(), body: match[2].trim() };
          }
          return { header: block, body: '' };
        }
        const header = block.slice(0, firstNewline).trim();
        const body = block.slice(firstNewline + 1).trim();
        const match = header.match(/^(.*?\([^)]*\d{4}[^)]*\))\s*:\s*(.*)$/s);
        if (match) {
          return {
            header: match[1].trim(),
            body: (match[2].trim() + '\n' + body).trim(),
          };
        }
        return { header, body };
      });
  });
}
