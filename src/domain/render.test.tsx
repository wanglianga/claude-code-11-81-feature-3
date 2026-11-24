import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { CalibrationPage } from '../pages/CalibrationPage';
import { CoveragePage } from '../pages/CoveragePage';

// 纯展示页面（不依赖 IndexedDB）在服务端渲染下应无运行时错误，并包含关键叙事文本。
describe('口径复算页面可渲染', () => {
  it('⑪ 页面包含统一表、回填判定与清淤贡献', () => {
    const html = renderToString(createElement(CalibrationPage));
    expect(html).toContain('淤积口径复算');
    expect(html).toContain('统一对照表');
    expect(html).toContain('26 ~ 36');
    expect(html).toContain('26 ~ 28');
    expect(html).toContain('清淤前');
    expect(html).toContain('CTR-SURVEY-V1');
    // 同次实测与换算异带的 S5 记录应显示“异带”
    expect(html).toContain('同次实测与换算异带');
  });

  it('⑫ 页面包含覆盖计数、规则试验与回放', () => {
    const html = renderToString(createElement(CoveragePage));
    expect(html).toContain('覆盖图、规则对照试验与批次撤销回放');
    expect(html).toContain('分母');
    expect(html).toContain('共同适用证据');
    expect(html).toContain('已发布图层');
    expect(html).toContain('撤销规程乙');
  });
});
