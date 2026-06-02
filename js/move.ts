import {Component} from '@wonderlandengine/api';
import {property} from '@wonderlandengine/api/decorators.js';

/**
 * move
 */
export class Move extends Component {
    static TypeName = 'move';


       @property.float(1.0)
       speed!: number;
   
       update(dt: number) {
           this.object.translateLocal([this.speed * dt, 0, 0]);
       }
}
