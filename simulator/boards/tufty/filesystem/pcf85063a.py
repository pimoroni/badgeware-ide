import time

class PCF85063A:
    def __init__(self, *args, **kwargs):
        pass

    def datetime(self, *args, **kwargs):
        if len(args):
            pass
        year, month, day, hour, minute, second, weekday, _ = time.localtime()
        return (year, month, day, hour, minute, second, weekday)

    def enable_timer_interrupt(self, enable):
        pass

    def set_timer(self, ticks):
        pass

    def read_timer_flag(self):
        return False

    def clear_timer_flag(self):
        pass

    def enable_alarm_interrupt(self, enable):
        pass

    def set_alarm(self, *args):
        pass

    def unset_alarm(self):
        pass

    def read_alarm_flag(self):
        return False

    def clear_alarm_flag(self):
        pass
