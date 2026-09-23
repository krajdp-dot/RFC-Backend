import { renderTemplate, renderCustomMessage, sanitizeTemplateVariable, formatAmountForMessage, TEMPLATES } from './templates.js';

describe('sanitizeTemplateVariable — section 11, plain text only', () => {
  it('strips anything HTML-tag-shaped rather than escaping it', () => {
    expect(sanitizeTemplateVariable('<script>alert(1)</script>ABC Fruits')).toBe('alert(1)ABC Fruits');
    expect(sanitizeTemplateVariable('<b>Bold</b> Name')).toBe('Bold Name');
  });

  it('collapses newlines and tabs — Meta template params cannot contain them', () => {
    expect(sanitizeTemplateVariable('Line1\nLine2\tLine3')).toBe('Line1 Line2 Line3');
  });

  it('trims and bounds length', () => {
    expect(sanitizeTemplateVariable('  padded  ')).toBe('padded');
    expect(sanitizeTemplateVariable('x'.repeat(1000)).length).toBe(512);
  });

  it('leaves ordinary business text untouched', () => {
    expect(sanitizeTemplateVariable('ABC Fruits Pvt Ltd')).toBe('ABC Fruits Pvt Ltd');
    expect(sanitizeTemplateVariable('12,500.00')).toBe('12,500.00');
  });
});

describe('renderTemplate', () => {
  it('renders SALE_CONFIRMATION with the exact copy section 10 specifies', () => {
    const { text, messageType, templateName } = renderTemplate('SALE_CONFIRMATION', {
      customer_name: 'ABC Fruits',
      items: '3 x Royal Red Apple',
      total: '6,150',
    });
    expect(text).toContain('Hello ABC Fruits,');
    expect(text).toContain('Your order from Rajdeep Fruits Company:');
    expect(text).toContain('3 x Royal Red Apple');
    expect(text).toContain('Total: \u20b96,150');
    expect(messageType).toBe('TRANSACTIONAL');
    expect(templateName).toBe('sale_confirmation');
  });

  it('renders PAYMENT_RECEIPT', () => {
    const { text } = renderTemplate('PAYMENT_RECEIPT', {
      customer_name: 'ABC Fruits',
      amount: '12,500',
      payment_mode: 'UPI',
      date: '20 Sep 2026',
    });
    expect(text).toContain('Payment received from ABC Fruits');
    expect(text).toContain('Amount: \u20b912,500');
    expect(text).toContain('Mode: UPI');
    expect(text).toContain('Date: 20 Sep 2026');
  });

  it('renders OUTSTANDING_REMINDER', () => {
    const { text, messageType } = renderTemplate('OUTSTANDING_REMINDER', {
      customer_name: 'ABC Fruits',
      outstanding: '42,500',
    });
    expect(text).toContain('₹42,500');
    expect(messageType).toBe('REMINDER');
  });

  it('renders STATEMENT with every ledger figure', () => {
    const { text } = renderTemplate('STATEMENT', {
      customer_name: 'ABC Fruits',
      opening: '0',
      sales: '50,000',
      payments: '35,000',
      outstanding: '15,000',
    });
    expect(text).toContain('Opening:\n\u20b90');
    expect(text).toContain('Sales:\n\u20b950,000');
    expect(text).toContain('Payments:\n\u20b935,000');
    expect(text).toContain('Outstanding:\n\u20b915,000');
  });

  it('sanitizes every variable before rendering — a malicious customer name cannot inject markup', () => {
    const { text } = renderTemplate('SALE_CONFIRMATION', {
      customer_name: '<img src=x onerror=alert(1)>',
      items: '1 item',
      total: '100',
    });
    expect(text).not.toContain('<img');
    expect(text).not.toContain('onerror');
  });

  it('throws on an unknown template key rather than sending something unrendered', () => {
    expect(() => renderTemplate('NOT_A_TEMPLATE' as any, {})).toThrow('Unknown WhatsApp template');
  });

  it('every template declares a metaVariableOrder matching the variables its render() actually uses', () => {
    for (const [key, def] of Object.entries(TEMPLATES)) {
      const sample = Object.fromEntries(def.metaVariableOrder.map((v) => [v, `TEST_${v}`]));
      const text = def.render(sample);
      const missing = def.metaVariableOrder.filter((varName) => !text.includes(`TEST_${varName}`));
      expect({ template: key, missing }).toEqual({ template: key, missing: [] });
    }
  });
});

describe('formatAmountForMessage — Indian digit grouping', () => {
  it('groups in the Indian pattern, not the Western one', () => {
    expect(formatAmountForMessage(1234567)).toBe('12,34,567');
    expect(formatAmountForMessage(100000)).toBe('1,00,000');
    expect(formatAmountForMessage(42500)).toBe('42,500');
  });

  it('leaves three or fewer digits ungrouped', () => {
    expect(formatAmountForMessage(500)).toBe('500');
    expect(formatAmountForMessage(0)).toBe('0');
  });

  it('keeps two decimal places only when the amount is not a whole number', () => {
    expect(formatAmountForMessage(1234.5)).toBe('1,234.50');
    expect(formatAmountForMessage(1234.567)).toBe('1,234.57');
    expect(formatAmountForMessage(1234)).toBe('1,234');
  });

  it('handles a string input the same as a number', () => {
    expect(formatAmountForMessage('42500.00')).toBe('42,500');
    expect(formatAmountForMessage('1234567.89')).toBe('12,34,567.89');
  });

  it('handles a negative amount', () => {
    expect(formatAmountForMessage(-42500)).toBe('-42,500');
  });
});

describe('renderCustomMessage', () => {
  it('sanitizes and bounds a free-text custom message', () => {
    expect(renderCustomMessage('<b>hi</b> there')).toBe('hi there');
    expect(renderCustomMessage('x'.repeat(2000)).length).toBe(1024);
  });
});
