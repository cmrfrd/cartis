import State, { Component, get, ref } from '@expressive/react';
import { describe, expect, it } from 'vitest';
import { click, mount, tick } from '../../test/util';

class ProbeModel extends State {
  count = 0;
  bump() {
    this.count++;
  }
  get double() {
    return this.count * 2;
  }
}

class ProbeView extends Component {
  n = 0;
  render() {
    const { n } = this;
    return (
      <button
        type="button"
        onClick={() => {
          this.n++;
        }}
      >
        clicks:{n}
      </button>
    );
  }
}

class ProbeHost extends Component {
  inner = new ProbeModel(); // adopted child model
  render() {
    return <ProbeReader />;
  }
}

class ProbeReader extends Component {
  host = get(ProbeHost, false); // context lookup as a field (optional form)
  render() {
    const { host } = this;
    return <span>value:{host ? host.inner.count : 'none'}</span>;
  }
}

class ProbeRef extends Component {
  box = ref<HTMLDivElement>();
  render() {
    return <div data-probe ref={this.box} />;
  }
}

describe('expressive probes (every idiom the app is built on)', () => {
  it('standalone model: fields update, flush awaits, getters compute', async () => {
    const probe = ProbeModel.new();
    probe.bump();
    await probe.set();
    expect(probe.count).toBe(1);
    expect(probe.double).toBe(2);
    probe.set(null);
  });

  it('mounted Component: click updates render', async () => {
    const { container, unmount } = mount(<ProbeView />);
    await tick();
    expect(container.textContent).toContain('clicks:0');
    await click(container.querySelector('button'));
    expect(container.textContent).toContain('clicks:1');
    unmount();
  });

  it('get(Type) field + transitive subscription through an adopted child model', async () => {
    let host: ProbeHost | undefined;
    const { container, unmount } = mount(
      <ProbeHost
        is={(instance: ProbeHost) => {
          host = instance;
        }}
      />,
    );
    await tick();
    expect(container.textContent).toContain('value:0');
    host?.inner.bump();
    await tick();
    expect(container.textContent).toContain('value:1');
    unmount();
  });

  it('ref() field instruction captures DOM nodes', async () => {
    let probe: ProbeRef | undefined;
    const { unmount } = mount(
      <ProbeRef
        is={(instance: ProbeRef) => {
          probe = instance;
        }}
      />,
    );
    await tick();
    expect(probe?.box.current).toBeInstanceOf(HTMLElement);
    unmount();
  });
});
