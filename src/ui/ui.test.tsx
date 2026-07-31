import { describe, expect, it, vi } from 'vitest';
import { click, mount, setInput, setSelect, tick } from '../../test/util';
import { Button, NumberInput, SelectInput, TabBar, TextInput } from './index';

describe('ui kit', () => {
  it('Button fires onClick', async () => {
    const onClick = vi.fn();
    const { container, unmount } = mount(<Button onClick={onClick}>Go</Button>);
    await tick();
    await click(container.querySelector('button'));
    expect(onClick).toHaveBeenCalledTimes(1);
    unmount();
  });

  it('TextInput reports typed value', async () => {
    const onValue = vi.fn();
    const { container, unmount } = mount(<TextInput value="" onValue={onValue} />);
    await tick();
    await setInput(container.querySelector('input'), 'Zara');
    expect(onValue).toHaveBeenCalledWith('Zara');
    unmount();
  });

  it('NumberInput clamps to min/max', async () => {
    const onValue = vi.fn();
    const { container, unmount } = mount(
      <NumberInput value={3} onValue={onValue} min={0} max={9} />,
    );
    await tick();
    await setInput(container.querySelector('input'), '42');
    expect(onValue).toHaveBeenCalledWith(9);
    await setInput(container.querySelector('input'), '-5');
    expect(onValue).toHaveBeenCalledWith(0);
    unmount();
  });

  it('SelectInput reports chosen option', async () => {
    const onValue = vi.fn();
    const options = [
      { value: 'a', label: 'Alpha' },
      { value: 'b', label: 'Beta' },
    ];
    const { container, unmount } = mount(
      <SelectInput value="a" onValue={onValue} options={options} />,
    );
    await tick();
    await setSelect(container.querySelector('select'), 'b');
    expect(onValue).toHaveBeenCalledWith('b');
    unmount();
  });

  it('TabBar renders tabs and reports selection', async () => {
    const onSelect = vi.fn();
    const tabs = [
      { id: 'one', label: 'One' },
      { id: 'two', label: 'Two' },
    ];
    const { container, unmount } = mount(<TabBar tabs={tabs} active="one" onSelect={onSelect} />);
    await tick();
    const buttons = Array.from(container.querySelectorAll('button'));
    expect(buttons.map((b) => b.textContent)).toEqual(['One', 'Two']);
    await click(buttons[1] ?? null);
    expect(onSelect).toHaveBeenCalledWith('two');
    unmount();
  });
});
