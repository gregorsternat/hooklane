import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Table } from './index';
import type { TableColumn } from './types';

type RecordRow = { id: string; name: string };

describe('server-paginated tables', () => {
  it('exposes every page row and its actions without viewport measurement', () => {
    const inspect = vi.fn();
    const columns: TableColumn<RecordRow>[] = [
      { key: 'name', header: 'Destination', width: '220px' },
      {
        key: 'actions',
        header: 'Actions',
        width: '100px',
        cell: (row) => (
          <button onClick={() => inspect(row.id)}>Inspect {row.name}</button>
        ),
      },
    ];
    const rows = Array.from({ length: 25 }, (_, index) => ({
      id: String(index),
      name: `Destination ${index + 1}`,
    }));
    const { rerender } = render(
      <Table
        data={rows}
        columns={columns}
        getRowId={(row) => row.id}
        virtualized={false}
      />,
    );

    const table = screen.getByRole('table');
    expect(within(table).getAllByRole('row')).toHaveLength(26);
    expect(table).toHaveAttribute('aria-rowcount', '26');
    expect(table).toHaveAttribute('aria-colcount', '2');
    expect(within(table).getAllByRole('columnheader')).toHaveLength(2);
    fireEvent.click(
      screen.getByRole('button', { name: 'Inspect Destination 25' }),
    );
    expect(inspect).toHaveBeenCalledWith('24');

    rerender(
      <Table
        data={[{ id: 'next', name: 'Next page' }]}
        columns={columns}
        getRowId={(row) => row.id}
        virtualized={false}
      />,
    );
    expect(screen.queryByText('Destination 25')).not.toBeInTheDocument();
    expect(within(table).getAllByRole('row')).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: 'Inspect Next page' }));
    expect(inspect).toHaveBeenLastCalledWith('next');
  });
});
