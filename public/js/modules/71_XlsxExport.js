  /* ══════════════════════════════════════════
     XLSX EXPORT — 엑셀 내보내기 (WO 20261019-gap1 R3)
     [재현] R3: grep -i "xlsx|spreadsheetml|officedocument.spreadsheet" public/js/modules/*.js
            → 05_SyncQueue.js:622 1건(첨부 아이콘 라벨일 뿐) → 실제 내보내기 0건.

     구현 선택(마스터 §3 지시 준수 — 의존성 추가 최소화):
     · 창고 검색(node warehouse.mjs search xlsx) 결과 = 재사용 가능한 "범용 XLSX writer" 없음
       (sampleGenerator.ts 는 목데이터 생성용, wd-checker 는 Node 전용 CLI 스크립트).
     · package.json 에 xlsx/jszip 류 의존성 0개 — 새 의존성을 추가하지 않고
       **SpreadsheetML 2003 XML**(단일 XML 문서, zip 불필요)로 생성한다. 엑셀이 .xls 확장자로
       바로 연다(OOXML .xlsx 와 달리 압축 라이브러리가 필요 없다 — CDN 지연로드도 불필요해진다).
     · 한글 셀 값은 XML 엔티티 이스케이프, 숫자 열은 Number 타입으로 셀을 쓴다(엑셀에서 숫자로 정렬/계산 가능).
       날짜 문자열은 그대로 String 타입(파서가 임의로 또 포맷하지 않음 — 지어내지 않음).
     · 열 너비는 ss:Width(포인트) 로 지정 — columns 에 {label, width} 형태도 허용(문자열만 와도 동작).
  ══════════════════════════════════════════ */
  const XlsxExport = {
    _esc(s) {
      return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    },
    /** 셀 하나 — 숫자(유한수)면 Number 타입, 그 외는 String 타입(한글 포함 전부 안전). */
    _cell(v) {
      if (typeof v === "number" && Number.isFinite(v)) {
        return '<Cell><Data ss:Type="Number">' + v + '</Data></Cell>';
      }
      return '<Cell><Data ss:Type="String">' + this._esc(v) + '</Data></Cell>';
    },
    _colLabel(c) { return (c && typeof c === "object") ? c.label : c; },
    _colWidth(c) { return (c && typeof c === "object" && Number.isFinite(c.width)) ? c.width : 90; },

    /** 순수 함수 — sheetName/columns/rows → SpreadsheetML 2003 XML 문자열(DOM·fetch 무의존, 테스트 대상).
     *  columns: string[] 또는 {label,width}[]. rows: 각 행이 같은 길이의 배열(값은 string|number|null). */
    build(sheetName, columns, rows) {
      const cols = Array.isArray(columns) ? columns : [];
      const list = Array.isArray(rows) ? rows : [];
      const colsXml = cols.map((c) => '<Column ss:Width="' + this._colWidth(c) + '"/>').join("");
      const headRow = "<Row>" + cols.map((c) => this._cell(this._colLabel(c))).join("") + "</Row>";
      const bodyRows = list.map((r) => "<Row>" + (r || []).map((v) => this._cell(v)).join("") + "</Row>").join("");
      const safeSheet = String(sheetName || "Sheet1").replace(/[\\/?*\[\]:]/g, "_").slice(0, 31) || "Sheet1";
      return '<?xml version="1.0"?>' +
        '<?mso-application progid="Excel.Sheet"?>' +
        '<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">' +
        '<Worksheet ss:Name="' + this._esc(safeSheet) + '">' +
        '<Table>' + colsXml + headRow + bodyRows + '</Table>' +
        '</Worksheet></Workbook>';
    },

    /** DOM 글루 — CSV 내보내기(19_PinGrid.js exportCsv)와 같은 다운로드 패턴. */
    download(filename, sheetName, columns, rows) {
      const xml = this.build(sheetName, columns, rows);
      const blob = new Blob(["﻿" + xml], { type: "application/vnd.ms-excel;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = /\.xls$/i.test(filename) ? filename : (filename + ".xls");
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
  };
