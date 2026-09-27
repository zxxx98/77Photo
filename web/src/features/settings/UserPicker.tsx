import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { Check, ChevronDown } from 'lucide-react';
import type { User } from '../../app/api';

type UserPickerProps = {
  users: User[];
  value: string;
  label: string;
  disabled?: boolean;
  onChange: (userID: string) => void;
};

export default function UserPicker({ users, value, label, disabled = false, onChange }: UserPickerProps) {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const listboxID = useId();
  const selectedIndex = Math.max(0, users.findIndex((user) => user.id === value));
  const selectedUser = users.find((user) => user.id === value) ?? users[0];

  useEffect(() => {
    if (!open) return;
    setActiveIndex(selectedIndex);

    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open, selectedIndex]);

  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  function moveActive(nextIndex: number) {
    if (users.length === 0) return;
    const wrapped = (nextIndex + users.length) % users.length;
    setActiveIndex(wrapped);
  }

  function choose(userID: string) {
    onChange(userID);
    setOpen(false);
  }

  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (disabled || users.length === 0) return;

    if (event.key === 'Escape') {
      if (open) {
        event.preventDefault();
        setOpen(false);
      }
      return;
    }

    if (event.key === 'ArrowDown') {
      event.preventDefault();
      if (!open) {
        setOpen(true);
        setActiveIndex(selectedIndex);
      } else {
        moveActive(activeIndex + 1);
      }
      return;
    }

    if (event.key === 'ArrowUp') {
      event.preventDefault();
      if (!open) {
        setOpen(true);
        setActiveIndex(selectedIndex);
      } else {
        moveActive(activeIndex - 1);
      }
      return;
    }

    if (!open) return;

    if (event.key === 'Home') {
      event.preventDefault();
      setActiveIndex(0);
    } else if (event.key === 'End') {
      event.preventDefault();
      setActiveIndex(users.length - 1);
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      choose(users[activeIndex]?.id ?? value);
    }
  }

  return <div className={`user-picker ${open ? 'is-open' : ''}`} ref={rootRef}>
    <button
      className="user-picker-trigger"
      type="button"
      role="combobox"
      aria-label={label}
      aria-controls={listboxID}
      aria-expanded={open}
      aria-haspopup="listbox"
      aria-activedescendant={open && users[activeIndex] ? `${listboxID}-${users[activeIndex].id}` : undefined}
      disabled={disabled || users.length === 0}
      onClick={() => setOpen((current) => !current)}
      onKeyDown={onKeyDown}
    >
      {selectedUser ? <>
        <span className="user-picker-avatar" aria-hidden="true">{selectedUser.username.slice(0, 1).toUpperCase()}</span>
        <span className="user-picker-name">{selectedUser.username}</span>
      </> : <span className="user-picker-name">{label}</span>}
      <ChevronDown className="user-picker-chevron" size={15} aria-hidden="true" />
    </button>
    {open && <div className="user-picker-menu" id={listboxID} role="listbox" aria-label={label}>
      {users.map((user, index) => {
        const selected = user.id === value;
        return <button
          className={`user-picker-option ${index === activeIndex ? 'is-active' : ''} ${selected ? 'is-selected' : ''}`}
          id={`${listboxID}-${user.id}`}
          key={user.id}
          type="button"
          role="option"
          aria-selected={selected}
          onMouseEnter={() => setActiveIndex(index)}
          onClick={() => choose(user.id)}
        >
          <span className="user-picker-avatar" aria-hidden="true">{user.username.slice(0, 1).toUpperCase()}</span>
          <span className="user-picker-name">{user.username}</span>
          {selected && <Check className="user-picker-check" size={15} aria-hidden="true" />}
        </button>;
      })}
    </div>}
  </div>;
}
